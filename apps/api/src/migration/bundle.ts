import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { BUNDLE_VERSION, type BundleManifest, type EntityType } from './types';
import { fromJsonlLine } from './serialize';
import { sha256File } from './hash';

export const MANIFEST_NAME = 'manifest.json';

export function bundlePath(base: string): string {
  return path.isAbsolute(base) ? base : path.resolve(process.cwd(), base);
}

export async function readManifest(bundleDir: string): Promise<BundleManifest> {
  const file = path.join(bundleDir, MANIFEST_NAME);
  const raw = await fsp.readFile(file, 'utf8');
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(raw) as BundleManifest;
  } catch {
    throw new Error(`迁移包清单不是合法 JSON：${file}`);
  }
  if (manifest.bundleVersion !== BUNDLE_VERSION) {
    throw new Error(`不支持的迁移包版本：${manifest.bundleVersion}，本工具支持 ${BUNDLE_VERSION}`);
  }
  if (!manifest.bundleId || !manifest.source?.familyId) {
    throw new Error('迁移包清单缺少 bundleId / source.familyId');
  }
  return manifest;
}

export function tableFile(bundleDir: string, entity: EntityType): string {
  return path.join(bundleDir, 'tables', `${entity}.jsonl`);
}

export function storageRoot(bundleDir: string): string {
  return path.join(bundleDir, 'storage');
}

export async function* iterRows(
  bundleDir: string,
  entity: EntityType,
): AsyncGenerator<Record<string, unknown>> {
  const file = tableFile(bundleDir, entity);
  let stream: fs.ReadStream | null = null;
  try {
    stream = fs.createReadStream(file);
  } catch {
    return;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      yield fromJsonlLine(line) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${entity}.jsonl 第 ${lineNo} 行无法解析：${(err as Error).message}`);
    }
  }
}

/** 统计 jsonl 行数（流式，避免大文件全量入内存）。 */
export async function countLines(file: string): Promise<number> {
  let n = 0;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) n += 1;
  } catch {
    // 缺文件按 0 行处理（空表可能未导出该文件）
  }
  return n;
}

export async function verifyManifestHashes(
  bundleDir: string,
  manifest: BundleManifest,
  onFile?: (name: string) => void,
): Promise<string[]> {
  const errors: string[] = [];
  for (const [name, meta] of Object.entries(manifest.files)) {
    onFile?.(name);
    const file = path.join(bundleDir, name);
    let st: fs.Stats | null = null;
    try {
      st = await fsp.stat(file);
    } catch {
      errors.push(`清单声明的文件缺失：${name}`);
      continue;
    }
    if (st.size !== meta.bytes) {
      errors.push(`文件大小与清单不符：${name}（实际 ${st.size}，清单 ${meta.bytes}）`);
    }
    const actual = await sha256File(file);
    if (actual !== meta.sha256) {
      errors.push(`sha256 校验失败：${name}`);
    }
  }
  return errors;
}

/** 逐行流式生成哈希输入，用于 export 时计算表文件摘要。 */
export function lineReader(input: Readable): readline.Interface {
  return readline.createInterface({ input, crlfDelay: Infinity });
}
