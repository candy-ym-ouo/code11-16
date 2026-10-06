/**
 * 全量导出：从源实例导出一个家庭的完整档案。
 *
 * 圈定范围 → 完整性自检（外键闭包）→ 复制媒体对象 → 写数据文件 → 算指纹与清单。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db, Row } from './db.js';
import {
  BUNDLE_FORMAT,
  INIT_MIGRATION,
  type BundleManifest,
  type MediaEntry,
  type MissingMedia,
  blobPath,
  dataFilePath,
} from './bundle.js';
import { canonicalJson, roundTrip, sha256Hex } from './ids.js';
import { MEDIA_KEY_COLUMNS, TABLES } from './schema.js';

export interface ExportOptions {
  bundleDir: string;
  familyId: string;
  sourceInstanceId: string;
  storageRoot: string;
  /** 媒体文件缺失时是否按错误处理（默认仅告警继续） */
  strictMedia?: boolean;
}

export interface ExportReport {
  bundleDir: string;
  familyName: string;
  rowsPerTable: Record<string, number>;
  totalRows: number;
  mediaCount: number;
  mediaBytes: number;
  mediaMissing: MissingMedia[];
  warnings: string[];
  fingerprint: string;
}

/** to_jsonb(t) 全列读取并做 JSON 往返规范化 */
async function selectRows(db: Db, table: string, where: string, params: unknown[]): Promise<Row[]> {
  let rows: { r: unknown }[];
  try {
    rows = await db.query(`select to_jsonb(t) as r from ${table} t where ${where}`, params);
  } catch (err) {
    throw new Error(`导出表 ${table} 失败：${(err as Error).message}`);
  }
  return rows.map((row) => roundTrip(row.r as Row));
}

/** 收集一行 item_media 上引用的所有存储 key（对象本体 + 派生文件） */
function mediaKeysOf(row: Row): string[] {
  const keys: string[] = [];
  for (const col of MEDIA_KEY_COLUMNS) {
    const v = row[col];
    if (typeof v === 'string' && v.length > 0) keys.push(v);
  }
  return keys;
}

export async function exportFamily(db: Db, opts: ExportOptions): Promise<ExportReport> {
  const { bundleDir, familyId, storageRoot } = opts;
  const warnings: string[] = [];

  const family = await db.queryOne<Row>(`select to_jsonb(t) as r from families t where id = $1`, [
    familyId,
  ]);
  if (!family) throw new Error(`源实例不存在家庭：${familyId}`);
  const familyRow = roundTrip(family.r as Row);
  const familyName = String(familyRow.name ?? familyId);

  // 1) 按拓扑序圈定各表数据（家庭作用域）
  const rowsByTable = new Map<string, Row[]>();
  for (const spec of TABLES) {
    if (spec.scope === 'family') {
      const where = spec.scopeWhere ?? (spec.table === 'families' ? 't.id = $1' : 't.family_id = $1');
      rowsByTable.set(spec.table, await selectRows(db, spec.table, where, [familyId]));
    } else {
      rowsByTable.set(spec.table, []); // users 稍后单独填充
    }
  }
  rowsByTable.set('families', [familyRow]);

  // 2) 收集被引用的用户 ID（成员关系 + 所有 created_by/author/actor/decided_by 等）
  const userIds = new Set<string>();
  const collectUserCols = new Set([
    'user_id',
    'created_by',
    'author_id',
    'decided_by',
    'actor_id',
  ]);
  for (const [table, rows] of rowsByTable) {
    const spec = TABLES.find((t) => t.table === table)!;
    for (const row of rows) {
      for (const col of spec.columns) {
        if (
          (col.kind === 'fk' || col.kind === 'fkSoft') &&
          col.refTable === 'users' &&
          collectUserCols.has(col.name)
        ) {
          const v = row[col.name];
          if (typeof v === 'string') userIds.add(v);
        }
      }
    }
  }
  if (userIds.size > 0) {
    const users: Row[] = [];
    // 参数不宜过多，分批查询
    const ids = [...userIds];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const placeholders = chunk.map((_, j) => `$${j + 1}`).join(',');
      const got = await db.query(
        `select to_jsonb(t) as r from users t where id in (${placeholders})`,
        chunk,
      );
      users.push(...got.map((row) => roundTrip(row.r as Row)));
    }
    rowsByTable.set('users', users);
  }

  // 3) 引用闭包自检：每个外键/软引用都必须能在本包内解析
  const idIndex = new Map<string, Set<string>>();
  for (const spec of TABLES) {
    const rows = rowsByTable.get(spec.table) ?? [];
    idIndex.set(spec.table, new Set(rows.map((r) => spec.pk.map((c) => String(r[c])).join('|'))));
  }
  for (const spec of TABLES) {
    for (const row of rowsByTable.get(spec.table) ?? []) {
      for (const col of spec.columns) {
        if (col.kind !== 'fk' && col.kind !== 'fkSoft') continue;
        const v = row[col.name];
        if (v === null || v === undefined) continue;
        // 自引用可能指向被合并的旧人物，软引用允许悬空（只有 fk 强制）
        const target = idIndex.get(col.refTable!)!;
        if (!target.has(String(v))) {
          const msg = `${spec.table}.${col.name}=${String(v).slice(0, 24)} 引用的 ${col.refTable} 不在导出范围内`;
          if (col.kind === 'fk') throw new Error(`导出数据引用不完整：${msg}`);
          warnings.push(`软引用悬空（可迁移）：${msg}`);
        }
      }
    }
  }

  // 4) 收集并复制媒体对象（内容寻址，去重）
  await fsp.rm(bundleDir, { recursive: true, force: true });
  await fsp.mkdir(path.join(bundleDir, 'data'), { recursive: true });
  await fsp.mkdir(path.join(bundleDir, 'blobs'), { recursive: true });

  const media: MediaEntry[] = [];
  const mediaMissing: MissingMedia[] = [];
  const seenHashes = new Set<string>();
  let mediaBytes = 0;
  for (const row of rowsByTable.get('item_media') ?? []) {
    for (const key of mediaKeysOf(row)) {
      const src = path.join(storageRoot, key);
      let buf: Buffer;
      try {
        buf = await fsp.readFile(src);
      } catch (err) {
        mediaMissing.push({ key, reason: (err as Error).message });
        continue;
      }
      const sha = sha256Hex(buf);
      // 仅对象本体列在数据库里登记了 sha256；派生文件（缩略图等）无对应列
      if (key === row.storage_key && row.sha256 && sha !== String(row.sha256)) {
        warnings.push(`媒体对象与记录的 sha256 不符：key=${key}`);
      }
      if (!seenHashes.has(sha)) {
        seenHashes.add(sha);
        await fsp.writeFile(blobPath(bundleDir, sha), buf);
        mediaBytes += buf.length;
      }
      media.push({ key, sha256: sha, bytes: buf.length, blob: `blobs/${sha}` });
    }
  }
  if (mediaMissing.length > 0 && opts.strictMedia) {
    throw new Error(`媒体文件缺失（--strict-media）：\n  - ${mediaMissing.map((m) => m.key).join('\n  - ')}`);
  }
  if (mediaMissing.length > 0) warnings.push(`${mediaMissing.length} 个媒体对象缺失，已在清单中登记`);

  // 5) 写数据文件
  const tableMetas: BundleManifest['tables'] = {};
  let totalRows = 0;
  for (const spec of TABLES) {
    const rows = rowsByTable.get(spec.table) ?? [];
    const json = JSON.stringify(rows);
    await fsp.writeFile(dataFilePath(bundleDir, spec.table), json);
    tableMetas[spec.table] = {
      rows: rows.length,
      bytes: Buffer.byteLength(json),
      sha256: sha256Hex(json),
    };
    totalRows += rows.length;
  }

  // 6) 清单与指纹（指纹覆盖除 manifest.* 外所有内容）
  const fingerprint = sha256Hex(
    canonicalJson({
      format: BUNDLE_FORMAT,
      familyId,
      tables: tableMetas,
      media: media.map((m) => ({ blob: m.blob, sha256: m.sha256, bytes: m.bytes })),
    }),
  );
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    createdAt: new Date().toISOString(),
    source: {
      instanceId: opts.sourceInstanceId,
      familyId,
      familyName,
      backend: db.backend,
    },
    schema: { initMigration: INIT_MIGRATION },
    tables: tableMetas,
    media,
    mediaMissing,
    totalRows,
    totalBytes: Object.values(tableMetas).reduce((n, m) => n + m.bytes, 0),
    fingerprint,
  };
  await fsp.writeFile(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(bundleDir, 'manifest.sig'), fingerprint);

  return {
    bundleDir,
    familyName,
    rowsPerTable: Object.fromEntries(TABLES.map((s) => [s.table, tableMetas[s.table]?.rows ?? 0])),
    totalRows,
    mediaCount: media.length,
    mediaBytes,
    mediaMissing,
    warnings,
    fingerprint,
  };
}
