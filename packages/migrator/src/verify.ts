/**
 * 迁移后验证：把目标端读出来，与“按同一套重映射规则预期的结果”逐行对账。
 *
 * 检查项：
 *  1. 每张表 inserted/adopted 行都能在目标端读到，内容指纹一致
 *  2. skipped 行在目标端不存在（按重映射后的主键）
 *  3. 外键完整性：迁移产生的行不存在悬空外键
 *  4. 媒体对象：重写后的每个 target_key 文件存在且 sha256 一致
 *
 * verify 与 apply 使用同一个 transformRow，保证“校验的就是写入的”。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db, Row } from './db.js';
import type { BundleManifest } from './bundle.js';
import { buildGlobalIdMap, buildIdMaps, targetPk, transformRow } from './remap.js';
import { normalizeTimestamp, roundTrip, sha256Hex } from './ids.js';
import { MEDIA_KEY_COLUMNS, TABLES } from './schema.js';

export interface VerifyOptions {
  manifest: BundleManifest;
  rowsByTable: Map<string, Row[]>;
  migrationId: string;
  targetStorageRoot: string;
}

export interface VerifyResult {
  ok: boolean;
  checkedRows: number;
  checkedMedia: number;
  problems: string[];
  perTable: Record<string, { expected: number; found: number }>;
}

function normalizeRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeTimestamp(roundTrip(v));
  return out;
}

export async function verifyTarget(db: Db, opts: VerifyOptions): Promise<VerifyResult> {
  const problems: string[] = [];
  const perTable: Record<string, { expected: number; found: number }> = {};
  let checkedRows = 0;
  let checkedMedia = 0;

  const idMaps = buildIdMaps(opts.rowsByTable, opts.migrationId);
  const oldFamilyId = opts.manifest.source.familyId;
  const newFamilyId = idMaps.get('families')!.get(oldFamilyId)!;

  // 从 idmap 取每个源行的实际结局
  const outcomes = await db.query<{ table_name: string; source_id: string; target_id: string; action: string }>(
    `select table_name, source_id, target_id, action from migrator_id_map where migration_id = $1`,
    [opts.migrationId],
  );
  const outcomeIndex = new Map<string, { target_id: string; action: string }>();
  for (const o of outcomes) outcomeIndex.set(`${o.table_name}:${o.source_id}`, o);

  // adopt 用户：实际写入的行引用的是目标端既有账号 ID，需回写映射后再转换
  for (const o of outcomes) {
    if (o.table_name === 'users' && o.action === 'adopted') {
      idMaps.get('users')!.set(o.source_id, o.target_id);
    }
  }
  const globalIdMap = buildGlobalIdMap(idMaps);

  for (const spec of TABLES) {
    const rows = opts.rowsByTable.get(spec.table) ?? [];
    let found = 0;
    perTable[spec.table] = { expected: rows.length, found: 0 };

    for (const sourceRow of rows) {
      const sourceId =
        spec.pk.length === 1
          ? String(sourceRow[spec.pk[0]!])
          : spec.pk.map((c) => String(sourceRow[c])).join('|');
      const outcome = outcomeIndex.get(`${spec.table}:${sourceId}`);
      if (!outcome) {
        problems.push(`${spec.table} 源行 ${sourceId.slice(0, 24)} 没有迁移结局记录`);
        continue;
      }
      const mapped = transformRow(spec, sourceRow, idMaps, globalIdMap, oldFamilyId, newFamilyId);
      const where = spec.pk.map((c, i) => `"${c}" = $${i + 1}`).join(' and ');
      const target = await db.queryOne<{ r: Row }>(
        `select to_jsonb(t) as r from ${spec.table} t where ${where} limit 1`,
        spec.pk.map((c) => (outcome.action === 'adopted' ? outcome.target_id : mapped[c])),
      );

      if (outcome.action === 'skipped') {
        // skip 分两种：天然键冲突（行可能作为“别的数据”存在，按内容不是我们的行即可）
        // 级联跳过：映射主键不应存在
        const pkVal = spec.pk.map((c) => mapped[c]).join('|');
        const cascaded = !spec.naturalKey || !spec.naturalKey.every((c) => mapped[c] !== undefined);
        if (cascaded && target) {
          problems.push(`${spec.table} 级联跳过行仍存在于目标端：pk=${pkVal.slice(0, 48)}`);
        }
        continue;
      }

      if (!target) {
        problems.push(`${spec.table} 缺少已${outcome.action === 'adopted' ? '采用' : '迁移'}的行：${sourceId.slice(0, 24)}`);
        continue;
      }
      found++;

      // adopted 用户：目标行归目标实例所有，只验证映射有效，不逐列比对
      if (outcome.action === 'adopted') continue;

      const actual = normalizeRow(roundTrip(target.r));
      const expected = normalizeRow(mapped);
      const actualPk = targetPk(spec, actual);
      const expectedPk = targetPk(spec, expected);
      if (JSON.stringify(actualPk) !== JSON.stringify(expectedPk)) {
        problems.push(`${spec.table} 主键映射不一致：${sourceId.slice(0, 24)}`);
        continue;
      }
      for (const col of spec.columns) {
        const a = JSON.stringify(actual[col.name]);
        const e = JSON.stringify(expected[col.name]);
        if (a !== e) {
          problems.push(
            `${spec.table}.${col.name} 内容不一致（源行 ${sourceId.slice(0, 16)}…）：期望 ${e?.slice(0, 80)}，实际 ${a?.slice(0, 80)}`,
          );
        }
      }
      checkedRows++;
    }
    perTable[spec.table]!.found = found;
  }

  // 外键完整性：仅检查迁移产生的行之间/到既有用户的引用
  for (const spec of TABLES) {
    for (const sourceRow of opts.rowsByTable.get(spec.table) ?? []) {
      const sourceId =
        spec.pk.length === 1
          ? String(sourceRow[spec.pk[0]!])
          : spec.pk.map((c) => String(sourceRow[c])).join('|');
      const outcome = outcomeIndex.get(`${spec.table}:${sourceId}`);
      if (!outcome || outcome.action === 'skipped') continue;
      const mapped = transformRow(spec, sourceRow, idMaps, globalIdMap, oldFamilyId, newFamilyId);
      for (const col of spec.columns) {
        if (col.kind !== 'fk') continue;
        const v = mapped[col.name];
        if (v === null || v === undefined) continue;
        // 采用用户的引用目标是目标库既有 ID；按引用表主键列（可能复合）查询
        const refSpec = TABLES.find((t) => t.table === col.refTable)!;
        const where = refSpec.pk
          .map((c, i) => `"${c}" = $${i + 1}`)
          .join(' and ');
        const pkValues =
          refSpec.pk.length === 1
            ? [v]
            : String(v).split('|'); // 迁移列只可能引用单列主键表，复合仅理论情况
        const hit = await db.queryOne(
          `select 1 from ${col.refTable} where ${where} limit 1`,
          pkValues,
        );
        if (!hit) {
          problems.push(`${spec.table}.${col.name} 悬空外键：${String(v).slice(0, 24)}（源行 ${sourceId.slice(0, 16)}…）`);
        }
      }
    }
  }

  // 媒体对象
  for (const sourceRow of opts.rowsByTable.get('item_media') ?? []) {
    const sourceId = String(sourceRow.id);
    const outcome = outcomeIndex.get(`item_media:${sourceId}`);
    if (!outcome || outcome.action === 'skipped') continue;
    for (const col of MEDIA_KEY_COLUMNS) {
      const key = sourceRow[col];
      if (typeof key !== 'string' || !key.startsWith(`families/${oldFamilyId}/`)) continue;
      const entry = opts.manifest.media.find((m) => m.key === key);
      if (!entry) continue;
      const targetKey = `families/${newFamilyId}/${key.slice(`families/${oldFamilyId}/`.length)}`;
      const abs = path.join(opts.targetStorageRoot, targetKey);
      let buf: Buffer;
      try {
        buf = await fsp.readFile(abs);
      } catch {
        problems.push(`媒体对象缺失：${targetKey}`);
        continue;
      }
      if (sha256Hex(buf) !== entry.sha256) {
        problems.push(`媒体对象 sha256 不一致：${targetKey}`);
      }
      checkedMedia++;
    }
  }

  const run = await db.queryOne<{ status: string }>(
    `select status from migrator_runs where migration_id = $1`,
    [opts.migrationId],
  );
  if (run?.status !== 'done') problems.push(`迁移运行状态为 ${run?.status ?? '不存在'}，期望 done`);

  return { ok: problems.length === 0, checkedRows, checkedMedia, problems, perTable };
}
