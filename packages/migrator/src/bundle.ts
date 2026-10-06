/**
 * 导出包（bundle）目录格式：
 *
 *   bundle/
 *     manifest.json          清单（自描述 + 全文件校验）
 *     manifest.sig           清单指纹（sha256，validate 时重算比对）
 *     data/<table>.json      每张表一个 JSON 数组（to_jsonb 结果，键为蛇形列名）
 *     blobs/<sha256>         媒体对象二进制（内容寻址，天然去重）
 *
 * 全量导出 = 家庭行 + 其全部从属表 + 被引用的用户行 + 媒体文件；
 * 不含 jobs / refresh_tokens / _prisma_migrations 等实例私有数据。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Row } from './db.js';
import { canonicalJson, sha256Hex } from './ids.js';
import { TABLES } from './schema.js';

export const BUNDLE_FORMAT = 'heirloom-family-bundle/v1';
export const INIT_MIGRATION = '20261004085533_init';

export interface MediaEntry {
  /** 源端存储 key，如 families/<fid>/objects/ab/abc....jpg */
  key: string;
  sha256: string;
  bytes: number;
  /** 包内相对路径 blobs/<sha256> */
  blob: string;
}

export interface MissingMedia {
  key: string;
  reason: string;
}

export interface TableFileMeta {
  rows: number;
  bytes: number;
  sha256: string;
}

export interface BundleManifest {
  format: string;
  createdAt: string;
  source: {
    instanceId: string;
    familyId: string;
    familyName: string;
    backend: string;
  };
  schema: { initMigration: string };
  tables: Record<string, TableFileMeta>;
  media: MediaEntry[];
  mediaMissing: MissingMedia[];
  totalRows: number;
  totalBytes: number;
  /** 除 manifest.json / manifest.sig 外全部文件的汇总指纹 */
  fingerprint: string;
}

export class BundleError extends Error {}

export function dataFilePath(dir: string, table: string): string {
  return path.join(dir, 'data', `${table}.json`);
}

export function blobPath(dir: string, sha: string): string {
  return path.join(dir, 'blobs', sha);
}

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const buf = await fsp.readFile(file);
  return { sha256: sha256Hex(buf), bytes: buf.length };
}

/** 读取并完整校验一个导出包：文件存在性 + 每个文件 sha256 + 清单指纹 */
export async function loadBundle(dir: string): Promise<{ manifest: BundleManifest }> {
  const manifestPath = path.join(dir, 'manifest.json');
  const sigPath = path.join(dir, 'manifest.sig');
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as BundleManifest;
  } catch (err) {
    throw new BundleError(`清单不可读（${manifestPath}）：${(err as Error).message}`);
  }
  if (manifest.format !== BUNDLE_FORMAT) {
    throw new BundleError(`不支持的导出包格式：${manifest.format}（期望 ${BUNDLE_FORMAT}）`);
  }

  const problems: string[] = [];

  // 校验数据表文件
  for (const spec of TABLES) {
    const meta = manifest.tables[spec.table];
    if (!meta) {
      problems.push(`清单缺少表 ${spec.table}`);
      continue;
    }
    const file = dataFilePath(dir, spec.table);
    if (!fs.existsSync(file)) {
      problems.push(`缺少数据文件 data/${spec.table}.json`);
      continue;
    }
    const { sha256, bytes } = await hashFile(file);
    if (sha256 !== meta.sha256) problems.push(`${spec.table} 数据文件 sha256 不一致`);
    if (bytes !== meta.bytes) problems.push(`${spec.table} 数据文件大小不一致`);
  }

  // 校验媒体对象
  for (const m of manifest.media) {
    const file = path.join(dir, m.blob);
    if (!fs.existsSync(file)) {
      problems.push(`缺少媒体对象 ${m.blob}（key=${m.key}）`);
      continue;
    }
    const { sha256, bytes } = await hashFile(file);
    if (sha256 !== m.sha256) problems.push(`媒体对象内容损坏：key=${m.key}`);
    if (bytes !== m.bytes) problems.push(`媒体对象大小不一致：key=${m.key}`);
  }

  // 重算清单指纹（输入必须与 export 写指纹时完全一致）
  const recomputed = sha256Hex(
    canonicalJson({
      format: manifest.format,
      familyId: manifest.source.familyId,
      tables: manifest.tables,
      media: manifest.media.map((m) => ({ blob: m.blob, sha256: m.sha256, bytes: m.bytes })),
    }),
  );
  const { fingerprint } = manifest;
  let sig = '';
  try {
    sig = (await fsp.readFile(sigPath, 'utf8')).trim();
  } catch {
    problems.push('缺少 manifest.sig');
  }
  if (sig && sig !== fingerprint) problems.push('清单记录的指纹与内容不符');
  if (sig && sig !== recomputed) problems.push('清单指纹重算失败（包被篡改或传输损坏）');

  if (problems.length > 0) {
    throw new BundleError(`导出包校验失败：\n  - ${problems.join('\n  - ')}`);
  }
  return { manifest };
}

export async function readTableRows(dir: string, table: string): Promise<Row[]> {
  const file = dataFilePath(dir, table);
  return JSON.parse(await fsp.readFile(file, 'utf8')) as Row[];
}

/** 读全部表（按依赖拓扑序），返回 { table: rows } */
export async function readAllRows(dir: string): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  for (const spec of TABLES) {
    out.set(spec.table, await readTableRows(dir, spec.table));
  }
  return out;
}
