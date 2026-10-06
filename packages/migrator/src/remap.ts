/**
 * 标识重映射（纯函数，apply 与 verify 共用同一份逻辑，保证“写入什么就校验什么”）。
 *
 * 规则见 schema.ts 的列声明：
 *  - id/fk/fkSoft：按 (table, sourceId) 查确定性映射
 *  - fkPoly：按本行 target_type 选表映射
 *  - json：深遍历，内嵌的旧 ID 与媒体 key 一并改写
 *  - 媒体 key 列：families/<旧家庭id>/ → families/<新家庭id>/
 */
import type { Row } from './db.js';
import { mapStringsDeep, remapId } from './ids.js';
import { MEDIA_KEY_COLUMNS, TABLES, type TableSpec } from './schema.js';

export type IdMaps = Map<string, Map<string, string>>;

/** 为包内每一行预计算确定性目标 ID（复合主键的每个 pk 列都登记映射） */
export function buildIdMaps(rowsByTable: Map<string, Row[]>, migrationId: string): IdMaps {
  const maps: IdMaps = new Map();
  for (const spec of TABLES) {
    const m = new Map<string, string>();
    for (const row of rowsByTable.get(spec.table) ?? []) {
      for (const pkCol of spec.pk) {
        m.set(String(row[pkCol]), remapId(migrationId, spec.table, String(row[pkCol])));
      }
    }
    maps.set(spec.table, m);
  }
  return maps;
}

/** 全局旧ID→新ID（仅登记“跨表无歧义”的 ID，供 JSON 深遍历使用） */
export function buildGlobalIdMap(idMaps: IdMaps): Map<string, string> {
  const counts = new Map<string, number>();
  const values = new Map<string, string>();
  for (const m of idMaps.values()) {
    for (const [oldId, newId] of m) {
      counts.set(oldId, (counts.get(oldId) ?? 0) + 1);
      values.set(oldId, newId);
    }
  }
  const global = new Map<string, string>();
  for (const [oldId, n] of counts) if (n === 1) global.set(oldId, values.get(oldId)!);
  return global;
}

const MEDIA_KEY_SET = new Set<string>(MEDIA_KEY_COLUMNS);

export function rewriteMediaKey(key: string, oldFamilyId: string, newFamilyId: string): string {
  const prefix = `families/${oldFamilyId}/`;
  return key.startsWith(prefix) ? `families/${newFamilyId}/${key.slice(prefix.length)}` : key;
}

/**
 * 转换一行。
 * @returns 重映射后的新行；若 mandatoryFk 无法解析返回 null（调用方按跳过处理）
 */
export function transformRow(
  spec: TableSpec,
  row: Row,
  idMaps: IdMaps,
  globalIdMap: Map<string, string>,
  oldFamilyId: string,
  newFamilyId: string,
): Row {
  const out: Row = {};
  for (const col of spec.columns) {
    const v = row[col.name];
    if (v === null || v === undefined) {
      out[col.name] = null;
      continue;
    }
    switch (col.kind) {
      case 'text':
        out[col.name] = v;
        break;
      case 'id':
        out[col.name] = idMaps.get(spec.table)!.get(String(v)) ?? remapId('?', spec.table, String(v));
        break;
      case 'fk':
      case 'fkSoft': {
        const mapped = idMaps.get(col.refTable!)!.get(String(v));
        if (!mapped) {
          if (col.kind === 'fk') {
            // 硬外键悬空：只可能是包本身不完整，交给上层报错
            throw new Error(`无法重映射 ${spec.table}.${col.name}=${String(v)} → ${col.refTable}`);
          }
          out[col.name] = v; // 软引用悬空：保留原值
        } else {
          out[col.name] = mapped;
        }
        break;
      }
      case 'fkPoly': {
        const type = String(row.target_type ?? '');
        const refTable = col.polyMap?.[type];
        const mapped = refTable ? idMaps.get(refTable)!.get(String(v)) : undefined;
        out[col.name] = mapped ?? v; // 未知类型 / 未迁移实体：原样保留
        break;
      }
      case 'json':
        out[col.name] = mapStringsDeep(v, (s) => {
          if (s.startsWith(`families/${oldFamilyId}/`)) {
            return rewriteMediaKey(s, oldFamilyId, newFamilyId);
          }
          return globalIdMap.get(s) ?? s;
        });
        break;
    }
  }
  // 媒体 key 列做路径前缀改写
  for (const colName of MEDIA_KEY_SET) {
    const v = out[colName];
    if (typeof v === 'string') out[colName] = rewriteMediaKey(v, oldFamilyId, newFamilyId);
  }
  return out;
}

/** 复合主键在目标端的取值（用于快照与幂等查找） */
export function targetPk(spec: TableSpec, mappedRow: Row): Record<string, unknown> {
  const pk: Record<string, unknown> = {};
  for (const c of spec.pk) pk[c] = mappedRow[c];
  return pk;
}
