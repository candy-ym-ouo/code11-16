import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { BUNDLE_VERSION, type BundleManifest, type EntityType, type StorageFileEntry, emptyCounts } from './types';
import { toJsonlLine } from './serialize';
import { sha256File, copyFileWithHash } from './hash';
import { latestMigration, storageAbs, walkFiles, type AnyPrisma } from './clients';
import { tableFile } from './bundle';

export interface ExportOptions {
  familyId: string;
  outDir: string;
  /** 包含软删除的条目/人物（默认包含，迁移不丢回收站数据） */
  includeDeleted?: boolean;
  onProgress?: (msg: string) => void;
}

export interface ExportResult {
  bundleDir: string;
  manifest: BundleManifest;
}

interface TableQuery {
  entity: EntityType;
  rows: (db: AnyPrisma, familyId: string) => Promise<Record<string, unknown>[]>;
}

/**
 * 每个实体的查询顺序即依赖顺序；只导出与该家庭相关的数据。
 * 用户按成员关系导出（一个用户可能属于多个家庭，只带走成员关系，不动账号本身以外的东西）。
 */
const TABLE_QUERIES: TableQuery[] = [
  { entity: 'family', rows: (db, fid) => db.family.findMany({ where: { id: fid } }) as Promise<Record<string, unknown>[]> },
  {
    entity: 'users',
    rows: async (db, fid) => {
      const members = await db.familyMember.findMany({ where: { familyId: fid }, select: { userId: true } });
      const ids = Array.from(new Set(members.map((m) => m.userId)));
      if (ids.length === 0) return [];
      return db.user.findMany({ where: { id: { in: ids } } }) as Promise<Record<string, unknown>[]>;
    },
  },
  { entity: 'settings', rows: (db, fid) => db.setting.findMany({ where: { familyId: fid } }) as Promise<Record<string, unknown>[]> },
  { entity: 'members', rows: (db, fid) => db.familyMember.findMany({ where: { familyId: fid } }) as Promise<Record<string, unknown>[]> },
  { entity: 'invites', rows: (db, fid) => db.invite.findMany({ where: { familyId: fid } }) as Promise<Record<string, unknown>[]> },
  { entity: 'items', rows: (db, fid) => db.item.findMany({ where: { familyId: fid } }) as Promise<Record<string, unknown>[]> },
  {
    entity: 'media',
    rows: async (db, fid) => {
      const items = await db.item.findMany({ where: { familyId: fid }, select: { id: true } });
      const ids = items.map((i) => i.id);
      if (ids.length === 0) return [];
      return db.itemMedia.findMany({ where: { itemId: { in: ids } } }) as Promise<Record<string, unknown>[]>;
    },
  },
  { entity: 'people', rows: (db, fid) => db.person.findMany({ where: { familyId: fid } }) as Promise<Record<string, unknown>[]> },
  {
    entity: 'itemPeople',
    rows: async (db, fid) => {
      const items = await db.item.findMany({ where: { familyId: fid }, select: { id: true } });
      const ids = items.map((i) => i.id);
      if (ids.length === 0) return [];
      return db.itemPerson.findMany({ where: { itemId: { in: ids } } }) as Promise<Record<string, unknown>[]>;
    },
  },
  {
    entity: 'notes',
    rows: async (db, fid) => {
      const items = await db.item.findMany({ where: { familyId: fid }, select: { id: true } });
      const ids = items.map((i) => i.id);
      if (ids.length === 0) return [];
      return db.itemNote.findMany({ where: { itemId: { in: ids } } }) as Promise<Record<string, unknown>[]>;
    },
  },
  {
    entity: 'itemShares',
    rows: async (db, fid) => {
      const items = await db.item.findMany({ where: { familyId: fid }, select: { id: true } });
      const ids = items.map((i) => i.id);
      if (ids.length === 0) return [];
      return db.itemShare.findMany({ where: { itemId: { in: ids } } }) as Promise<Record<string, unknown>[]>;
    },
  },
  {
    entity: 'versions',
    rows: async (db, fid) => {
      const items = await db.item.findMany({ where: { familyId: fid }, select: { id: true } });
      const ids = items.map((i) => i.id);
      if (ids.length === 0) return [];
      return db.itemVersion.findMany({ where: { itemId: { in: ids } } }) as Promise<Record<string, unknown>[]>;
    },
  },
  { entity: 'shareLinks', rows: (db, fid) => db.shareLink.findMany({ where: { familyId: fid } }) as Promise<Record<string, unknown>[]> },
  {
    entity: 'shareLinkItems',
    rows: async (db, fid) => {
      const links = await db.shareLink.findMany({ where: { familyId: fid }, select: { id: true } });
      const ids = links.map((l) => l.id);
      if (ids.length === 0) return [];
      return db.shareLinkItem.findMany({ where: { shareLinkId: { in: ids } } }) as Promise<Record<string, unknown>[]>;
    },
  },
  { entity: 'auditLogs', rows: (db, fid) => db.auditLog.findMany({ where: { familyId: fid }, orderBy: { createdAt: 'asc' } }) as Promise<Record<string, unknown>[]> },
];

export async function exportFamily(db: PrismaClient, storageRoot: string, opts: ExportOptions): Promise<ExportResult> {
  const log = opts.onProgress ?? (() => undefined);
  const family = await db.family.findUnique({ where: { id: opts.familyId } });
  if (!family) throw new Error(`源端不存在家庭 ${opts.familyId}`);
  if (family.deletedAt && opts.includeDeleted !== true) {
    log(`注意：家庭已被软删除（${family.deletedAt.toISOString()}），仍将导出全部数据`);
  }

  const bundleId = randomBytes(16).toString('hex');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bundleDir = path.join(opts.outDir, `migration-${bundleId.slice(0, 12)}-${stamp}`);
  await fsp.mkdir(path.join(bundleDir, 'tables'), { recursive: true });

  const counts = emptyCounts();
  const files: BundleManifest['files'] = {};

  for (const q of TABLE_QUERIES) {
    const rows = await q.rows(db, opts.familyId);
    counts[q.entity] = rows.length;
    const file = tableFile(bundleDir, q.entity);
    const lines = rows.map(toJsonlLine);
    const body = lines.length ? lines.join('\n') + '\n' : '';
    await fsp.writeFile(file, body, 'utf8');
    const sha = await sha256File(file);
    const st = await fsp.stat(file);
    files[`tables/${q.entity}.jsonl`] = { sha256: sha, bytes: st.size, rows: rows.length };
    log(`  表 ${q.entity}: ${rows.length} 行`);
  }

  // 媒体文件：整个家庭的内容寻址目录（objects 原始件 + derived 缩略图/波形/转码）
  log('复制媒体文件（按内容寻址，天然去重）…');
  const storagePrefix = path.posix.join('families', opts.familyId);
  const allFiles = await walkFiles(storageRoot, storagePrefix);
  const storageFiles: StorageFileEntry[] = [];
  let mediaBytes = 0;
  for (const f of allFiles) {
    const dest = path.join(bundleDir, 'storage', f.rel);
    const { sha256, bytes } = await copyFileWithHash(f.abs, dest);
    storageFiles.push({ rel: f.rel, sha256, size: bytes });
    mediaBytes += bytes;
  }
  log(`  媒体 ${storageFiles.length} 个文件，共 ${(mediaBytes / 1024 / 1024).toFixed(1)} MiB`);

  const migration = await latestMigration(db).catch(() => null);

  const manifest: BundleManifest = {
    app: '家中物品来历册',
    bundleVersion: BUNDLE_VERSION,
    bundleId,
    createdAt: new Date().toISOString(),
    source: {
      familyId: family.id,
      familyName: family.name,
      migration,
      database: maskUrl(extractDbName(db)),
    },
    counts,
    mediaBytes,
    files,
    storageFiles,
  };
  await fsp.writeFile(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  await fsp.writeFile(
    path.join(bundleDir, 'README.txt'),
    [
      '家中物品来历册 · 跨实例迁移包',
      '',
      `家庭：${family.name}（源 ID：${family.id}）`,
      `打包时间：${manifest.createdAt}`,
      `迁移包 ID：${bundleId}`,
      '',
      '目录说明：',
      '  manifest.json        清单（行数、文件大小与 sha256），目标端只信这个文件',
      '  tables/*.jsonl       每张表一个 JSON Lines 文件，一行一条记录',
      '  storage/             按内容寻址的媒体原件与派生文件（缩略图/波形/转码）',
      '',
      '导入到新实例：',
      '  TARGET_DATABASE_URL=postgres://... pnpm migrate:import --bundle <本目录>',
      '',
      '迁移幂等：同一迁移包重复导入不会产生重复数据；',
      '导入失败可用 pnpm migrate:rollback --run <批次ID> 回滚到迁移前状态。',
      '',
    ].join('\n'),
    'utf8',
  );

  log(`迁移包完成：${bundleDir}`);
  return { bundleDir, manifest };
}

function extractDbName(db: PrismaClient): string {
  try {
    const ds = (db as unknown as { _engine?: { config?: { datasourceOverrides?: { db?: { url?: string } } } } });
    return ds._engine?.config?.datasourceOverrides?.db?.url ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function maskUrl(url: string): string {
  return url.replace(/:\/\/[^:/?]+:[^@/?]+@/, '://***:***@');
}
