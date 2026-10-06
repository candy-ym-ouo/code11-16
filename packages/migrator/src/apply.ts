/**
 * apply：把导出包写入目标实例。
 *
 * 幂等模型
 *  - 目标 ID 由 (migrationId, 表, 源ID) 确定性派生，重放结果稳定
 *  - migrator_id_map 记录每个源行的结局：inserted / adopted / skipped
 *    · inserted：新插入，重放时按目标主键 upsert，无副作用
 *    · adopted：天然键冲突且本表允许采用（users 按 email），映射到既有目标行
 *    · skipped：天然键冲突（邀请码/分享令牌等），该行及其从属闭包级联跳过
 *  - 断点续跑：按表分批提交，崩溃后重跑只补未完成批次（先查 idmap / 目标行）
 *
 * 回滚模型（失败可回到迁移前快照）
 *  - 每张写入/覆盖的目标行在 migrator_snapshots 留下前像（inserted→删，updated→还原）
 *  - 每个写入/覆盖的媒体文件在 migrator_media_snapshots 登记，旧文件备份到状态目录
 *  - 失败默认自动回滚；也可 `migrator rollback --migration-id ...` 事后手工回滚
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db, DbTx, Row } from './db.js';
import type { BundleManifest } from './bundle.js';
import { buildGlobalIdMap, buildIdMaps, targetPk, transformRow, type IdMaps } from './remap.js';
import type { Conflict } from './preflight.js';
import { canonicalJson, roundTrip, sha256Hex } from './ids.js';
import { MEDIA_KEY_COLUMNS, TABLES, type ColumnSpec, type TableSpec } from './schema.js';

export interface ApplyOptions {
  bundleDir: string;
  manifest: BundleManifest;
  rowsByTable: Map<string, Row[]>;
  migrationId: string;
  sourceInstanceId: string;
  targetStorageRoot: string;
  stateDir: string;
  conflicts: Conflict[];
  /** 失败时自动回滚（默认 true）；false 则保留现场用于续跑 */
  autoRollback?: boolean;
  /** 测试/演练用：在导入到第 N 行数据后注入一次失败 */
  failAfter?: number;
  /** 每批提交的行数（断点续跑粒度），默认 200 */
  batchSize?: number;
  onProgress?: (msg: string) => void;
}

export interface TableStat {
  total: number;
  inserted: number;
  adopted: number;
  skipped: number;
}

export interface ApplyReport {
  migrationId: string;
  status: 'done' | 'failed' | 'rolled_back';
  stats: Record<string, TableStat>;
  mediaCopied: number;
  mediaOverwritten: number;
  mediaBytes: number;
  error?: string;
}

function escIdent(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`非法标识符：${s}`);
  return `"${s}"`;
}

const jsonLikeColumns = new Set<string>(['item_versions.snapshot', 'audit_logs.diff', 'settings.value']);
const arrayColumns = new Set<string>(['items.tags']);

function isJsonLike(spec: TableSpec, col: string): boolean {
  return jsonLikeColumns.has(`${spec.table}.${col}`);
}
function isArrayCol(spec: TableSpec, col: string): boolean {
  return arrayColumns.has(`${spec.table}.${col}`);
}

function bindValue(spec: TableSpec, col: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (isJsonLike(spec, col)) return JSON.stringify(value);
  if (isArrayCol(spec, col)) return JSON.stringify(value);
  return value;
}

function valueExpr(spec: TableSpec, col: string, idx: number): string {
  if (isJsonLike(spec, col)) return `$${idx + 1}::jsonb`;
  // text[] 从 jsonb 数组转换（jsonb 可作为两种列的统一传输格式）
  if (isArrayCol(spec, col))
    return `(select coalesce(array_agg(e), '{}'::text[]) from jsonb_array_elements_text($${idx + 1}::jsonb) e)`;
  return `$${idx + 1}`;
}

function buildUpsertSql(spec: TableSpec): string {
  const cols = spec.columns.map((c) => c.name);
  const colList = cols.map(escIdent).join(', ');
  const values = cols.map((c, i) => valueExpr(spec, c, i)).join(', ');
  const pkList = spec.pk.map(escIdent).join(', ');
  const updateSet = cols
    .filter((c) => !spec.pk.includes(c))
    .map((c) => `${escIdent(c)} = excluded.${escIdent(c)}`)
    .join(', ');
  const conflict = updateSet
    ? `on conflict (${pkList}) do update set ${updateSet}`
    : `on conflict (${pkList}) do nothing`;
  return `insert into ${escIdent(spec.table)} (${colList}) values (${values}) ${conflict}`;
}

async function fetchExistingRow(tx: DbTx, spec: TableSpec, mapped: Row): Promise<Row | null> {
  const where = spec.pk
    .map((c, i) => `${escIdent(c)} = $${i + 1}`)
    .join(' and ');
  const row = await tx.queryOne<{ r: Row }>(
    `select to_jsonb(t) as r from ${escIdent(spec.table)} t where ${where} limit 1`,
    spec.pk.map((c) => mapped[c]),
  );
  return row ? roundTrip(row.r) : null;
}

async function snapshotRow(
  tx: DbTx,
  migrationId: string,
  spec: TableSpec,
  mapped: Row,
  oldRow: Row | null,
): Promise<void> {
  const pkJson = canonicalJson(targetPk(spec, mapped));
  const dup = await tx.queryOne(
    `select 1 from migrator_snapshots
     where migration_id = $1 and table_name = $2 and target_pk::text = $3 limit 1`,
    [migrationId, spec.table, pkJson],
  );
  if (dup) return;
  await tx.query(
    `insert into migrator_snapshots (migration_id, table_name, target_pk, action, old_row)
     values ($1, $2, $3::jsonb, $4, $5::jsonb)`,
    [migrationId, spec.table, pkJson, oldRow ? 'updated' : 'inserted', oldRow ? JSON.stringify(oldRow) : null],
  );
}

async function recordIdMap(
  tx: DbTx,
  migrationId: string,
  table: string,
  sourceId: string,
  targetId: string,
  action: 'inserted' | 'adopted' | 'skipped',
): Promise<void> {
  await tx.query(
    `insert into migrator_id_map (migration_id, table_name, source_id, target_id, action)
     values ($1, $2, $3, $4, $5)
     on conflict (migration_id, table_name, source_id) do update
       set target_id = excluded.target_id, action = excluded.action`,
    [migrationId, table, sourceId, targetId, action],
  );
}

/** 读取本次迁移已有的 idmap（断点续跑用） */
async function loadExistingMap(
  tx: DbTx,
  migrationId: string,
): Promise<Map<string, Map<string, { targetId: string; action: string }>>> {
  const rows = await tx.query<{ table_name: string; source_id: string; target_id: string; action: string }>(
    `select table_name, source_id, target_id, action from migrator_id_map where migration_id = $1`,
    [migrationId],
  );
  const out = new Map<string, Map<string, { targetId: string; action: string }>>();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Map());
    out.get(r.table_name)!.set(r.source_id, { targetId: r.target_id, action: r.action });
  }
  return out;
}

/** 计算跳过根（天然键 skip 冲突）及其全部从属闭包 */
function computeSkipClosure(
  rowsByTable: Map<string, Row[]>,
  idMaps: IdMaps,
  conflicts: Conflict[],
): Set<string> {
  const skipped = new Set<string>();
  for (const c of conflicts) {
    if (c.policy !== 'skip') continue;
    const newId = idMaps.get(c.table)?.get(c.sourceId);
    if (newId) skipped.add(`${c.table}:${newId}`);
  }
  // 拓扑序向下传播：硬外键指向已跳过集合的行也跳过
  for (const spec of TABLES) {
    for (const row of rowsByTable.get(spec.table) ?? []) {
      for (const col of spec.columns) {
        if (col.kind !== 'fk') continue;
        const newRef = idMaps.get(col.refTable!)?.get(String(row[col.name] ?? ''));
        if (newRef && skipped.has(`${col.refTable}:${newRef}`)) {
          const newPk = spec.pk.map((c) => idMaps.get(spec.table)!.get(String(row[c]))).join('|');
          skipped.add(`${spec.table}:${newPk}`);
          break;
        }
      }
    }
  }
  return skipped;
}

interface PreparedRow {
  spec: TableSpec;
  sourceId: string;
  mapped: Row;
  kind: 'data' | 'adopt-user' | 'skip';
  adoptTargetId?: string;
}

export async function applyBundle(db: Db, opts: ApplyOptions): Promise<ApplyReport> {
  const autoRollback = opts.autoRollback ?? true;
  const batchSize = opts.batchSize ?? 200;
  const progress = opts.onProgress ?? (() => {});

  await fsp.mkdir(path.join(opts.stateDir, 'media-backup'), { recursive: true });

  const idMaps = buildIdMaps(opts.rowsByTable, opts.migrationId);
  const oldFamilyId = opts.manifest.source.familyId;
  const newFamilyId = idMaps.get('families')!.get(oldFamilyId)!;

  const adoptUsers = new Map<string, string>();
  for (const c of opts.conflicts) {
    if (c.table === 'users' && c.policy === 'adopt') adoptUsers.set(c.sourceId, c.targetId);
  }
  // adopt 用户：把 users 映射表中该用户的派生目标改写成目标端既有账号 ID，
  // 这样所有引用该用户的外键列（members/notes/audit/...）都自动指向正确目标。
  for (const [sourceId, targetId] of adoptUsers) {
    idMaps.get('users')!.set(sourceId, targetId);
  }
  // adopt 改写后重建全局映射，供 JSON 内嵌 ID 的深遍历使用
  const globalIdMap = buildGlobalIdMap(idMaps);
  const skipClosure = computeSkipClosure(opts.rowsByTable, idMaps, opts.conflicts);

  const stats: Record<string, TableStat> = {};
  for (const spec of TABLES) {
    stats[spec.table] = {
      total: (opts.rowsByTable.get(spec.table) ?? []).length,
      inserted: 0,
      adopted: 0,
      skipped: 0,
    };
  }

  const report: ApplyReport = {
    migrationId: opts.migrationId,
    status: 'done',
    stats,
    mediaCopied: 0,
    mediaOverwritten: 0,
    mediaBytes: 0,
  };

  // 预生成所有行的处理计划（纯计算，便于分批与续跑）
  const plan: PreparedRow[] = [];
  for (const spec of TABLES) {
    for (const sourceRow of opts.rowsByTable.get(spec.table) ?? []) {
      const sourceId =
        spec.pk.length === 1
          ? String(sourceRow[spec.pk[0]!])
          : spec.pk.map((c) => String(sourceRow[c])).join('|');
      const mapped = transformRow(spec, sourceRow, idMaps, globalIdMap, oldFamilyId, newFamilyId);
      const adoptedId = spec.table === 'users' ? adoptUsers.get(String(sourceRow.id)) : undefined;
      if (adoptedId) {
        plan.push({ spec, sourceId, mapped, kind: 'adopt-user', adoptTargetId: adoptedId });
        continue;
      }
      const newPkValue = spec.pk.map((c) => String(mapped[c])).join('|');
      if (skipClosure.has(`${spec.table}:${newPkValue}`)) {
        plan.push({ spec, sourceId, mapped, kind: 'skip' });
        continue;
      }
      plan.push({ spec, sourceId, mapped, kind: 'data' });
    }
  }

  try {
    // run 记录（独立小事务，续跑时复用）
    await db.transaction(async (tx) => {
      const run = await tx.queryOne<{ status: string }>(
        'select status from migrator_runs where migration_id = $1',
        [opts.migrationId],
      );
      if (!run) {
        await tx.query(
          `insert into migrator_runs
             (migration_id, source_instance_id, source_family_id, bundle_fingerprint, status, stats)
           values ($1, $2, $3, $4, 'running', '{}'::jsonb)`,
          [opts.migrationId, opts.sourceInstanceId, oldFamilyId, opts.manifest.fingerprint],
        );
      } else if (run.status !== 'running') {
        await tx.query(
          `update migrator_runs set status = 'running', error = null, finished_at = null, rolled_back_at = null
           where migration_id = $1`,
          [opts.migrationId],
        );
      }
    });

    // ---- 媒体对象（事务外复制，文件系统天然按内容/路径幂等）----
    // 复制前先登记快照，保证文件一旦写入就可回滚；重复运行跳过已登记对象。
    const copiedKeys = new Set<string>();
    const mediaRows = opts.rowsByTable.get('item_media') ?? [];
    for (const row of mediaRows) {
      const mappedItem = idMaps.get('items')!.get(String(row.item_id))!;
      if (skipClosure.has(`items:${mappedItem}`)) continue;
      for (const col of MEDIA_KEY_COLUMNS) {
        const key = row[col];
        if (typeof key !== 'string' || !key.startsWith(`families/${oldFamilyId}/`)) continue;
        const entry = opts.manifest.media.find((m) => m.key === key);
        if (!entry) continue; // 缺失媒体在 export 已登记
        const targetKey = `families/${newFamilyId}/${key.slice(`families/${oldFamilyId}/`.length)}`;
        if (copiedKeys.has(targetKey)) continue;
        copiedKeys.add(targetKey);

        // eslint-disable-next-line @typescript-eslint/no-loop-func
        const already = await db.queryOne(
          `select 1 from migrator_media_snapshots where migration_id = $1 and target_key = $2 limit 1`,
          [opts.migrationId, targetKey],
        );
        if (already) continue;

        const blob = await fsp.readFile(path.join(opts.bundleDir, entry.blob));
        if (sha256Hex(blob) !== entry.sha256) throw new Error(`媒体对象导入时校验失败：${key}`);
        const abs = path.join(opts.targetStorageRoot, targetKey);
        let action: 'copied' | 'overwritten' = 'copied';
        let oldBlobPath: string | null = null;
        if (fs.existsSync(abs)) {
          action = 'overwritten';
          const backupAbs = path.join(opts.stateDir, 'media-backup', targetKey);
          await fsp.mkdir(path.dirname(backupAbs), { recursive: true });
          await fsp.copyFile(abs, backupAbs);
          oldBlobPath = path.relative(opts.stateDir, backupAbs);
        }
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, blob);
        await db.query(
          `insert into migrator_media_snapshots (migration_id, target_key, action, old_blob_path)
           values ($1, $2, $3, $4)`,
          [opts.migrationId, targetKey, action, oldBlobPath],
        );
        if (action === 'overwritten') report.mediaOverwritten++;
        report.mediaCopied++;
        report.mediaBytes += blob.length;
      }
    }

    // ---- 数据行（按批事务提交，崩溃可续跑）----
    let processed = 0;
    for (let start = 0; start < plan.length; start += batchSize) {
      const batch = plan.slice(start, start + batchSize);
      await db.transaction(async (tx) => {
        const existingMap = await loadExistingMap(tx, opts.migrationId);
        for (const item of batch) {
          const { spec, sourceId, mapped, kind } = item;
          const prior = existingMap.get(spec.table)?.get(sourceId);
          if (prior) {
            stats[spec.table]![prior.action as 'inserted' | 'adopted' | 'skipped']++;
            processed++;
            continue;
          }

          if (kind === 'adopt-user') {
            await recordIdMap(tx, opts.migrationId, spec.table, sourceId, item.adoptTargetId!, 'adopted');
            stats[spec.table]!.adopted++;
            processed++;
            if (opts.failAfter !== undefined && processed === opts.failAfter) {
              throw new Error(`注入失败：已处理 ${processed} 行（演练回滚/续跑用）`);
            }
            continue;
          }
          if (kind === 'skip') {
            await recordIdMap(
              tx,
              opts.migrationId,
              spec.table,
              sourceId,
              String(mapped[spec.pk[0]!]),
              'skipped',
            );
            stats[spec.table]!.skipped++;
            processed++;
            if (opts.failAfter !== undefined && processed === opts.failAfter) {
              throw new Error(`注入失败：已处理 ${processed} 行（演练回滚/续跑用）`);
            }
            continue;
          }

          // data：拍前像 + upsert + 登记映射，同生共死
          const oldRow = await fetchExistingRow(tx, spec, mapped);
          await snapshotRow(tx, opts.migrationId, spec, mapped, oldRow);
          const cols = spec.columns.map((c: ColumnSpec) => c.name);
          await tx.query(
            buildUpsertSql(spec),
            cols.map((c) => bindValue(spec, c, mapped[c])),
          );
          await recordIdMap(
            tx,
            opts.migrationId,
            spec.table,
            sourceId,
            String(mapped[spec.pk[0]!]),
            'inserted',
          );
          stats[spec.table]!.inserted++;
          processed++;

          if (opts.failAfter !== undefined && processed === opts.failAfter) {
            throw new Error(`注入失败：已处理 ${processed} 行（演练回滚/续跑用）`);
          }
        }
      });
      progress(`已提交 ${Math.min(start + batchSize, plan.length)}/${plan.length} 行`);
    }

    await db.query(
      `update migrator_runs
         set status = 'done', stats = $2::jsonb, finished_at = now(), error = null
       where migration_id = $1`,
      [opts.migrationId, JSON.stringify(stats)],
    );
    progress(`迁移完成：${plan.length} 行已处理，媒体 ${report.mediaCopied} 个`);
    return report;
  } catch (err) {
    const message = (err as Error).message;
    report.error = message;
    if (autoRollback) {
      progress(`apply 失败，自动回滚到迁移前快照：${message}`);
      await rollback(db, {
        migrationId: opts.migrationId,
        targetStorageRoot: opts.targetStorageRoot,
        stateDir: opts.stateDir,
        progress,
      });
      report.status = 'rolled_back';
    } else {
      await db
        .query(`update migrator_runs set status = 'failed', error = $2, finished_at = now() where migration_id = $1`, [
          opts.migrationId,
          message,
        ])
        .catch(() => {});
      report.status = 'failed';
    }
    return report;
  }
}

// ---------------- 回滚 ----------------

export interface RollbackOptions {
  migrationId: string;
  targetStorageRoot: string;
  stateDir: string;
  progress?: (msg: string) => void;
}

/**
 * 按快照回滚：
 *  1. 业务表逆拓扑序：inserted 快照删除对应行；updated 快照用 old_row 还原
 *  2. 媒体文件：copied 删除；overwritten 用状态目录里的备份恢复
 *  3. 清理本次 idmap / 快照；run 标记 rolled_back
 */
export async function rollback(db: Db, opts: RollbackOptions): Promise<void> {
  const progress = opts.progress ?? (() => {});
  await db.transaction(async (tx) => {
    const run = await tx.queryOne<{ status: string }>(
      'select status from migrator_runs where migration_id = $1',
      [opts.migrationId],
    );
    if (!run) throw new Error(`找不到迁移运行：${opts.migrationId}`);

    // 1) 逆序还原数据行
    const snaps = await tx.query<{
      table_name: string;
      target_pk: Row;
      action: string;
      old_row: Row | null;
    }>(
      `select table_name, target_pk, action, old_row
       from migrator_snapshots where migration_id = $1 order by id desc`,
      [opts.migrationId],
    );
    let restoredRows = 0;
    for (const s of snaps) {
      const spec = TABLES.find((t) => t.table === s.table_name);
      if (!spec) continue;
      const where = spec.pk.map((c, i) => `${escIdent(c)} = $${i + 1}`).join(' and ');
      const pkVals = spec.pk.map((c) => s.target_pk[c]);
      if (s.action === 'inserted') {
        await tx.query(`delete from ${escIdent(s.table_name)} where ${where}`, pkVals);
      } else if (s.action === 'updated' && s.old_row) {
        const cols = spec.columns.map((c) => c.name);
        const set = cols.map((c) => `${escIdent(c)} = excluded.${escIdent(c)}`).join(', ');
        const params = cols.map((c) => bindValue(spec, c, s.old_row![c]));
        const selectVals = cols
          .map((c, i) => {
            // 回滚路径：旧数组以 jsonb 传输并转 text[]
            if (isArrayCol(spec, c)) {
              return `(select coalesce(array_agg(e), '{}'::text[]) from jsonb_array_elements_text($${i + 1}::jsonb) e)`;
            }
            return valueExpr(spec, c, i);
          })
          .join(', ');
        await tx.query(
          `insert into ${escIdent(s.table_name)} (${cols.map(escIdent).join(', ')})
           values (${selectVals})
           on conflict (${spec.pk.map(escIdent).join(', ')}) do update set ${set}`,
          params,
        );
      }
      restoredRows++;
    }

    // 2) 媒体文件还原
    const mediaSnaps = await tx.query<{ target_key: string; action: string; old_blob_path: string | null }>(
      `select target_key, action, old_blob_path from migrator_media_snapshots
       where migration_id = $1 order by id desc`,
      [opts.migrationId],
    );
    for (const m of mediaSnaps) {
      const abs = path.join(opts.targetStorageRoot, m.target_key);
      if (m.action === 'copied') {
        await fsp.rm(abs, { force: true });
      } else if (m.action === 'overwritten' && m.old_blob_path) {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.copyFile(path.join(opts.stateDir, m.old_blob_path), abs);
      }
    }

    // 3) 清理本次迁移痕迹并标记 rolled_back
    await tx.query('delete from migrator_id_map where migration_id = $1', [opts.migrationId]);
    await tx.query('delete from migrator_snapshots where migration_id = $1', [opts.migrationId]);
    await tx.query('delete from migrator_media_snapshots where migration_id = $1', [opts.migrationId]);
    await tx.query(
      `update migrator_runs set status = 'rolled_back', rolled_back_at = now(), finished_at = now()
       where migration_id = $1`,
      [opts.migrationId],
    );
    progress(`回滚完成：处理 ${restoredRows} 行、${mediaSnaps.length} 个媒体对象`);
  });
}
