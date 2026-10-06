import path from 'node:path';
import fs from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { REPO_ROOT } from '../config';

/**
 * 迁移 CLI 与运行中的 API 共用代码，但源端/目标端必须指向不同的库。
 * 这里独立解析 DATABASE_URL / TARGET_DATABASE_URL，不经过主 config
 * （主 config 会强制要求 JWT_SECRET 等运行期变量，运维机上不一定有）。
 */
loadEnv({ path: path.join(REPO_ROOT, '.env') });

export interface MigrationEndpoints {
  sourceUrl: string;
  targetUrl: string;
  sourceStorageRoot: string;
  targetStorageRoot: string;
}

function absStorage(p: string | undefined, fallback: string): string {
  const v = p && p.trim() ? p : fallback;
  return path.isAbsolute(v) ? v : path.join(REPO_ROOT, v);
}

export function resolveEndpoints(): MigrationEndpoints {
  const sourceUrl = process.env.DATABASE_URL?.trim();
  if (!sourceUrl) {
    throw new Error('缺少源端 DATABASE_URL（在环境变量或 .env 中配置）');
  }
  const targetUrl = process.env.TARGET_DATABASE_URL?.trim();
  const sourceStorageRoot = absStorage(process.env.STORAGE_ROOT, './data/uploads');
  const targetStorageRoot = absStorage(process.env.TARGET_STORAGE_ROOT, process.env.STORAGE_ROOT ?? './data/uploads');
  return { sourceUrl, targetUrl: targetUrl || sourceUrl, sourceStorageRoot, targetStorageRoot };
}

export function makeClient(url: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url } },
    log: ['warn', 'error'],
  });
}

export type AnyPrisma = PrismaClient;

/** 读取源端最后一个成功应用的 Prisma 迁移名（用于版本兼容校验）。 */
export async function latestMigration(prisma: PrismaClient): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
    select migration_name
    from _prisma_migrations
    where finished_at is not null
    order by finished_at desc
    nulls last
    limit 1
  `;
  return rows[0]?.migration_name ?? null;
}

/** 目标端是否已应用迁移台账表（migration_records）。 */
export async function hasLedgerTables(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    select count(*)::bigint as count
    from information_schema.tables
    where table_schema = 'public' and table_name = 'migration_records'
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}

export function storageAbs(storageRoot: string, key: string): string {
  const target = path.join(storageRoot, key);
  const root = path.resolve(storageRoot);
  if (!path.resolve(target).startsWith(root)) {
    throw new Error(`非法的存储 key: ${key}`);
  }
  return target;
}

/**
 * 递归列出 <root>/<prefix> 下的所有文件。
 * rel 始终相对 root（例如 prefix=families/f1 时返回 families/f1/objects/x.png）。
 */
export async function walkFiles(root: string, prefix: string): Promise<{ rel: string; abs: string }[]> {
  const out: { rel: string; abs: string }[] = [];
  const startDir = path.join(root, prefix);
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        out.push({ rel, abs });
      }
    }
  }
  await walk(startDir);
  return out;
}
