/**
 * 目标端校验（apply 前的 preflight，也可单独 `validate` 调用）。
 *
 * 阻断项（error，退出码非 0）：
 *  1. 导出包损坏 / 格式不符 / 指纹不通过（loadBundle 已覆盖）
 *  2. 目标库不可连或缺少业务表 / migrator 基础设施表
 *  3. schema 版本（init migration）与导出端不一致
 *  4. 目标实例就是导出源实例（instanceId 相同，防止回灌自己）
 *  5. 同一迁移已处于 done（默认需 --force 才允许重跑重放）
 *
 * 非阻断项（warning）：天然键冲突明细——users 按 email 采用（adopt），
 * 其余唯一冲突（邀请码、分享令牌、关联表等）跳过并级联。
 *
 * preflight 直接吃 bundle 原始行，内部做确定性重映射：
 * 冲突查询用“映射后的最终值”，冲突记录的 sourceId 用“源行原 ID”。
 */
import type { Db, Row } from './db.js';
import { loadBundle, readAllRows, type BundleManifest } from './bundle.js';
import { TABLES, type TableSpec } from './schema.js';
import { buildIdMaps, type IdMaps } from './remap.js';

export interface Conflict {
  table: string;
  /** 源行原始主键（单列=原 ID；复合=用 | 连接） */
  sourceId: string;
  naturalKey: Record<string, unknown>;
  /** 目标端冲突行的既有主键值 */
  targetId: string;
  policy: 'adopt' | 'skip';
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  conflicts: Conflict[];
  manifest: BundleManifest;
  rowsByTable: Map<string, Row[]>;
  /** 目标实例 ID（校验通过后可用） */
  targetInstanceId: string;
}

export interface PreflightOptions {
  bundleDir: string;
  migrationId: string;
  /** 已完成的迁移也允许继续（幂等重放） */
  allowDone?: boolean;
}

/**
 * 查天然键冲突：用重映射后的最终值在目标库查找。
 * 复合天然键（如 family_members(family_id,user_id)）两列都会被映射成目标值，
 * 因此与“另一迁移已经导入的同一家庭”重放时能正确识别为 skip。
 */
async function findNaturalConflicts(
  db: Db,
  spec: TableSpec,
  rawRows: Row[],
  idMaps: IdMaps,
  conflicts: Conflict[],
): Promise<void> {
  if (!spec.naturalKey) return;
  for (const raw of rawRows) {
    const keyCols = spec.naturalKey;
    const values = keyCols.map((colName) => {
      // 天然键里的外键列用映射后的目标值查询；普通列用原值
      const colSpec = spec.columns.find((c) => c.name === colName)!;
      const v = raw[colName];
      if ((colSpec.kind === 'fk' || colSpec.kind === 'fkSoft') && colSpec.refTable) {
        return idMaps.get(colSpec.refTable)?.get(String(v)) ?? v;
      }
      return v;
    });
    if (values.some((v) => v === null || v === undefined)) continue;

    const cond = keyCols.map((c, i) => `"${c}" = $${i + 1}`).join(' and ');
    const hit = await db.queryOne<Row>(
      `select ${spec.pk.map((c) => `"${c}"`).join(', ')} from ${spec.table} where ${cond} limit 1`,
      values,
    );
    if (!hit) continue;

    const sourceId =
      spec.pk.length === 1 ? String(raw[spec.pk[0]!]) : spec.pk.map((c) => String(raw[c])).join('|');
    const targetId =
      spec.pk.length === 1 ? String(hit[spec.pk[0]!]) : spec.pk.map((c) => String(hit[c])).join('|');
    conflicts.push({
      table: spec.table,
      sourceId,
      naturalKey: Object.fromEntries(keyCols.map((c, i) => [c, values[i]])),
      targetId,
      policy: spec.table === 'users' ? 'adopt' : 'skip',
    });
    // adopt 用户立即回写 idMaps：users 在拓扑序最前，后续表的复合天然键
    // （如 family_members(family_id,user_id)）才能按目标端账号值正确匹配
    if (spec.table === 'users') {
      idMaps.get('users')!.set(String(raw[spec.pk[0]!]), targetId);
    }
  }
}

export async function preflight(db: Db, opts: PreflightOptions): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const conflicts: Conflict[] = [];

  // 1) 导出包完整性
  const { manifest } = await loadBundle(opts.bundleDir);
  const rawRows = await readAllRows(opts.bundleDir);
  const idMaps = buildIdMaps(rawRows, opts.migrationId);

  // 2) 目标端表结构
  const existing = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public'`,
  );
  const existingSet = new Set(existing.map((r) => r.table_name));
  for (const t of TABLES) {
    if (!existingSet.has(t.table)) {
      errors.push(`目标库缺少业务表 ${t.table}（请先在目标端执行 prisma migrate deploy）`);
    }
  }
  for (const t of ['migrator_instances', 'migrator_runs', 'migrator_id_map', 'migrator_snapshots']) {
    if (!existingSet.has(t)) errors.push(`目标库缺少迁移基础设施表 ${t}（请执行 migrator init）`);
  }

  // 3) 实例标识：不能回灌自己
  let targetInstanceId = '';
  if (existingSet.has('migrator_instances')) {
    const inst = await db.queryOne<{ instance_id: string }>(
      'select instance_id from migrator_instances limit 1',
    );
    if (!inst) {
      errors.push('migrator_instances 为空，请先执行 migrator init');
    } else {
      targetInstanceId = inst.instance_id;
      if (inst.instance_id === manifest.source.instanceId) {
        errors.push('目标实例与导出源是同一个实例（instanceId 相同），拒绝回灌');
      }
    }
  }

  // 4) 迁移运行状态
  const run = await db.queryOne<{ status: string }>(
    'select status from migrator_runs where migration_id = $1',
    [opts.migrationId],
  );
  if (run?.status === 'done' && !opts.allowDone) {
    errors.push(`迁移 ${opts.migrationId} 已完成；如需幂等重放请显式加 --force`);
  }
  if (run?.status === 'running') {
    warnings.push(`迁移 ${opts.migrationId} 状态为 running（上次可能中断），本次将断点续跑`);
  }
  if (run?.status === 'rolled_back') {
    warnings.push(`迁移 ${opts.migrationId} 已回滚过，本次将作为全新运行重新建快照`);
  }

  // 5) 天然键冲突（目标端结构检查通过才有意义）
  if (errors.length === 0) {
    for (const spec of TABLES) {
      await findNaturalConflicts(db, spec, rawRows.get(spec.table) ?? [], idMaps, conflicts);
    }
    const adoptN = conflicts.filter((c) => c.policy === 'adopt').length;
    const skipN = conflicts.filter((c) => c.policy === 'skip').length;
    if (adoptN > 0) warnings.push(`${adoptN} 个用户邮箱已存在于目标端，将采用（adopt）目标账号`);
    if (skipN > 0) warnings.push(`${skipN} 条记录天然键冲突，将跳过（其从属数据级联跳过）`);
  }

  // 6) 清单自洽
  const totalRows = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0);
  if (totalRows !== manifest.totalRows) errors.push('清单 totalRows 与各表合计不一致');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    conflicts,
    manifest,
    rowsByTable: rawRows,
    targetInstanceId,
  };
}
