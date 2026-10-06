import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

/** 流式计算文件 sha256，避免大媒体文件整包读进内存。 */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function sha256Buffer(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 复制文件的同时计算 sha256，用于媒体文件落盘后的内容校验。 */
export async function copyFileWithHash(src: string, dest: string): Promise<{ sha256: string; bytes: number }> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const hash = createHash('sha256');
  const tmp = `${dest}.part-${process.pid}`;
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(tmp);
    rs.on('data', (c) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      hash.update(buf);
      bytes += buf.length;
    });
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
  await fs.promises.rename(tmp, dest);
  return { sha256: hash.digest('hex'), bytes };
}

export async function streamHashAndSize(input: Readable): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of input) {
    const c = chunk as Buffer;
    hash.update(c);
    bytes += c.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}
