import type { Decimal } from '@prisma/client/runtime/library';

/**
 * JSONL 序列化：Prisma 行里混着 Date / BigInt / Decimal，普通 JSON 表达不了，
 * 这里用带类型标签的对象承载，import 时再还原成 Prisma 能接受的形态
 * （Date 还原为 Date；BigInt 还原为 BigInt；Decimal 以字符串交回 Prisma）。
 */

function isDecimal(v: unknown): v is Decimal {
  return (
    typeof v === 'object' &&
    v !== null &&
    !(v instanceof Date) &&
    typeof (v as { toFixed?: unknown }).toFixed === 'function' &&
    typeof (v as { d?: unknown }).d !== 'undefined'
  );
}

/**
 * 手动把一行转成 JSON 安全结构：Date / BigInt / Decimal 用带前缀的字符串标签承载，
 * 不用对象标签（JSON.parse reviver 自底向上，对象标签与 Decimal 内部的 {s,e,d}
 * 结构会相互干扰）。
 */
const DATE_TAG = '$date:';
const BIGINT_TAG = '$bigint:';
const DECIMAL_TAG = '$decimal:';

function encodeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return BIGINT_TAG + value.toString();
  if (value instanceof Date) return DATE_TAG + value.toISOString();
  if (isDecimal(value)) return DECIMAL_TAG + value.toFixed();
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encodeValue(v);
    return out;
  }
  return value;
}

export function toJsonlLine(row: Record<string, unknown>): string {
  return JSON.stringify(encodeValue(row));
}

export function fromJsonlLine(line: string): Record<string, unknown> {
  return JSON.parse(line, (_key, value: unknown) => {
    if (typeof value === 'string') {
      if (value.startsWith(BIGINT_TAG)) return BigInt(value.slice(BIGINT_TAG.length));
      if (value.startsWith(DATE_TAG)) return new Date(value.slice(DATE_TAG.length));
      if (value.startsWith(DECIMAL_TAG)) return value.slice(DECIMAL_TAG.length);
    }
    return value;
  });
}

/**
 * 递归重写任意 JSON 值里的引用字段。
 * - 命中 id 映射：返回目标端 id；
 * - 命中存储 key 映射：改写 families/<旧fid>/ 前缀；
 * 其余结构（数组、快照 JSON、diff）原样保留。
 */
export function rewriteValue(
  value: unknown,
  idMap: ReadonlyMap<string, string>,
  storagePrefixes: { from: string; to: string } | null,
): unknown {
  if (typeof value === 'string') {
    const mapped = idMap.get(value);
    if (mapped !== undefined) return mapped;
    if (storagePrefixes && value.startsWith(storagePrefixes.from)) {
      return storagePrefixes.to + value.slice(storagePrefixes.from.length);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteValue(v, idMap, storagePrefixes));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteValue(v, idMap, storagePrefixes);
    }
    return out;
  }
  return value;
}
