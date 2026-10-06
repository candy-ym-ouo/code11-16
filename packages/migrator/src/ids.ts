/**
 * 标识重映射与规范化工具。
 *
 * 目标端 ID 不沿用源端 CUID（避免跨实例碰撞、也避免误并数据），
 * 而是由 (migrationId, table, sourceId) 经 SHA-256 确定性派生：
 * 同一 bundle 重放任意次结果都相同 → 幂等；两次不同迁移互不干扰 → 安全。
 */
import { createHash, randomBytes } from 'node:crypto';

const CUID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成 24 位 CUID 风格标识（首字母 c + 23 位 base36）。
 * 真实应用用 @paralleldrive/cuid2，迁移工具为零额外依赖自行实现。
 */
export function newId(): string {
  const bytes = randomBytes(18);
  let out = 'c';
  for (let i = 0; i < 23; i++) {
    out += CUID_ALPHABET[bytes[i % bytes.length]! % CUID_ALPHABET.length]!;
  }
  return out;
}

/**
 * 确定性派生 ID：同一输入永远得到同一输出（幂等重放的基石）。
 * 派生结果带 'm' 前缀，肉眼可辨“迁移产生的行”。
 */
export function remapId(migrationId: string, table: string, sourceId: string): string {
  const digest = createHash('sha256')
    .update('heirloom-migrate/v1\n')
    .update(migrationId)
    .update('\0')
    .update(table)
    .update('\0')
    .update(sourceId)
    .digest();
  let out = 'm';
  for (let i = 0; i < 23; i++) {
    out += CUID_ALPHABET[digest[i]! % CUID_ALPHABET.length]!;
  }
  return out;
}

/** 实例 ID：每个数据库一个随机标识，写入 migrator_instances */
export function newInstanceId(): string {
  return 'inst_' + randomBytes(12).toString('hex');
}

/** 迁移 ID：mig_<时间戳>_<随机>，也可由 --migration-id 指定 */
export function newMigrationId(): string {
  return `mig_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}_${randomBytes(5).toString('hex')}`;
}

/** 规范化 JSON（键排序），用于行指纹与文件指纹 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(roundTrip(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  }
  return value;
}

/**
 * JSON 往返 + 规范化：抹平两种后端的类型/格式差异
 *  - bigint -> number（byte_size 等在 JSON 里本来就是数字）
 *  - Date -> ISO 字符串
 *  - undefined -> null
 */
export function roundTrip<T>(value: T): T {
  if (value === undefined) return null as T;
  if (typeof value === 'bigint') return Number(value) as T;
  if (value instanceof Date) return value.toISOString() as T;
  if (Array.isArray(value)) return value.map(roundTrip) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v === undefined ? null : roundTrip(v);
    }
    return out as T;
  }
  return value;
}

/**
 * 时间戳规范化：Postgres TIMESTAMP(3) 不带时区，to_jsonb 输出 "2026-10-04T08:00:00.000"，
 * PGlite 输出可能带 Z；verify 比较时统一转成毫秒精度 ISO（按 UTC 解释）。
 */
export function normalizeTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!m) return value;
  const ms = (m[3] ?? '.000').padEnd(4, '0');
  // 不带时区信息时，两种后端都按 UTC 读出，直接补 Z
  return `${m[1]}T${m[2]}${ms}Z`;
}

/** 行指纹：规范化键序与时间格式后的 sha256，用于 export/verify 对账 */
export function fingerprintRow(row: Record<string, unknown>, remapped = false): string {
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    normalized[k] = normalizeTimestamp(v);
  }
  return createHash('sha256')
    .update(canonicalJson(normalized))
    .update(remapped ? '\nmapped' : '\norigin')
    .digest('hex');
}

/** 深遍历 JSON 值；对每个字符串叶子调用 visit，按其返回值替换 */
export function mapStringsDeep(value: unknown, visit: (s: string) => string): unknown {
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) return value.map((v) => mapStringsDeep(v, visit));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = mapStringsDeep(v, visit);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
