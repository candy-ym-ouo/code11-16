import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { config as appConfig } from '../config';
import { storageAbs, walkFiles } from './clients';
import { copyFileWithHash, sha256File } from './hash';

/**
 * 迁移前快照。
 *
 * 回滚的主路径是「按迁移台账精确删除本次迁移写入的数据库行」，
 * 但导入也可能覆盖目标端已有文件（sha256 相同的媒体复用同一 key，
 * 覆盖的是家庭前缀路径）。因此导入前对目标家庭存储子树做一份只读快照，
 * 回滚时把被覆盖/新增的文件还原或删除。
 *
 * 快照目录：data/backups/migration-snapshots/<runId>/
 *   ├── meta.json          # 目标家庭、时间、文件清单
 *   └── storage/...        # 迁移前该家庭目录下的全部文件
 */
export interface SnapshotMeta {
  runId: string;
  targetFamilyId: string;
  createdAt: string;
  files: { rel: string; sha256: string; size: number }[];
}

export function snapshotBaseDir(): string {
  return path.join(appConfig.BACKUP_ROOT, 'migration-snapshots');
}

export function snapshotDir(runId: string): string {
  return path.join(snapshotBaseDir(), runId);
}

export async function createPreSnapshot(
  targetStorageRoot: string,
  targetFamilyId: string,
  runId: string,
  onProgress?: (msg: string) => void,
): Promise<{ dir: string; meta: SnapshotMeta; hadExistingData: boolean }> {
  const log = onProgress ?? (() => undefined);
  const dir = snapshotDir(runId);
  const storagePrefix = path.posix.join('families', targetFamilyId);
  const existing = await walkFiles(targetStorageRoot, storagePrefix);

  await fsp.mkdir(path.join(dir, 'storage'), { recursive: true });
  const metaFiles: SnapshotMeta['files'] = [];
  for (const f of existing) {
    const dest = path.join(dir, 'storage', f.rel);
    const { sha256, bytes } = await copyFileWithHash(f.abs, dest);
    metaFiles.push({ rel: f.rel, sha256, size: bytes });
  }
  const meta: SnapshotMeta = {
    runId,
    targetFamilyId,
    createdAt: new Date().toISOString(),
    files: metaFiles,
  };
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  log(`迁移前快照：${existing.length} 个媒体文件 → ${dir}`);
  return { dir, meta, hadExistingData: existing.length > 0 };
}

export async function readSnapshotMeta(runId: string): Promise<SnapshotMeta | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(snapshotDir(runId), 'meta.json'), 'utf8')) as SnapshotMeta;
  } catch {
    return null;
  }
}

export interface RollbackResult {
  deletedRows: Record<string, number>;
  filesRestored: number;
  filesRemoved: number;
  runId: string;
  targetFamilyId: string;
}

/**
 * 按迁移台账回滚：
 *   1. 删除 migration_records 记录的所有目标端新行（按依赖逆序，含媒体文件引用）；
 *      邮箱合并到目标既有账号的用户不删，只删本次迁移新建的用户；
 *   2. 还原快照中被覆盖的媒体文件，删除导入新增的媒体文件；
 *   3. 删除迁移批次与台账本身；
 *   4. 空家庭（导入创建的）一并删除。
 * 回滚本身幂等：重复执行结果一致。
 */
export async function rollbackRun(
  db: PrismaClient,
  targetStorageRoot: string,
  runId: string,
  onProgress?: (msg: string) => void,
): Promise<RollbackResult> {
  const log = onProgress ?? (() => undefined);
  const run = await db.migrationRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`找不到迁移批次 ${runId}`);

  const bundleId = run.bundleId;
  const targetFamilyId = run.targetFamily ?? run.sourceFamily;
  const deletedRows: Record<string, number> = {};

  // 合并用户绝不能删：它们是目标端既有账号。从各批次 stats 里汇总合并记录。
  const mergedTargetIds = new Set<string>();
  const allRuns = await db.migrationRun.findMany({ where: { bundleId }, select: { stats: true, startedAt: true } });
  for (const r of allRuns) {
    const merged = (r.stats as { mergedUsers?: { targetId: string }[] } | null)?.mergedUsers ?? [];
    for (const m of merged) mergedTargetIds.add(m.targetId);
  }

  // 依赖逆序：先删引用方，再删被引用方。复合主键表用原始 SQL 按台账删。
  const deleteOrder: { entity: string; table: string; model?: keyof PrismaClient; composite?: [string, string] }[] = [
    { entity: 'shareLinkItems', table: 'share_link_items', composite: ['share_link_id', 'item_id'] },
    { entity: 'auditLogs', table: 'audit_logs', model: 'auditLog' },
    { entity: 'versions', table: 'item_versions', model: 'itemVersion' },
    { entity: 'itemShares', table: 'item_shares', model: 'itemShare' },
    { entity: 'notes', table: 'item_notes', model: 'itemNote' },
    { entity: 'itemPeople', table: 'item_people', model: 'itemPerson' },
    { entity: 'media', table: 'item_media', model: 'itemMedia' },
    { entity: 'shareLinks', table: 'share_links', model: 'shareLink' },
    { entity: 'invites', table: 'invites', model: 'invite' },
    { entity: 'people', table: 'people', model: 'person' },
    { entity: 'items', table: 'items', model: 'item' },
    { entity: 'members', table: 'family_members', model: 'familyMember' },
    { entity: 'settings', table: 'settings', composite: ['family_id', 'key'] },
    { entity: 'users', table: 'users', model: 'user' },
  ];

  for (const { entity, table, model, composite } of deleteOrder) {
    const records = await db.migrationRecord.findMany({
      where: { bundleId, entityType: entity },
      select: { targetId: true },
    });
    if (records.length === 0) continue;

    if (composite) {
      let count = 0;
      for (const rec of records) {
        const [a, b] = rec.targetId.split('|');
        if (!a || !b) continue;
        count += await db.$executeRawUnsafe(
          `delete from ${table} where ${composite[0]} = $1 and ${composite[1]} = $2`,
          a,
          b,
        );
      }
      deletedRows[entity] = count;
      log(`  删除 ${entity}: ${count}/${records.length} 行`);
      continue;
    }

    let ids = records.map((r) => r.targetId);
    if (entity === 'users') {
      const before = ids.length;
      ids = ids.filter((id) => !mergedTargetIds.has(id));
      if (before !== ids.length) log(`  保留 ${before - ids.length} 个合并到目标端的既有账号`);
    }
    const delegate = db[model!] as unknown as {
      deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }>;
    };
    const res = await delegate.deleteMany({ where: { id: { in: ids } } });
    deletedRows[entity] = res.count;
    log(`  删除 ${entity}: ${res.count}/${ids.length} 行（其余可能已被级联删除）`);
  }

  // family：只有迁移时新建的家庭（run.stats.familyCreated）且回滚后已空才删除；
  // 用 --target-family 导入到既有家庭时，无论数据剩多少都保留家庭本身。
  const familyLedger = await db.migrationRecord.findFirst({
    where: { bundleId, entityType: 'family' },
  });
  if (familyLedger) {
    const family = await db.family.findUnique({ where: { id: familyLedger.targetId } });
    if (family) {
      const firstRun = allRuns.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0];
      const familyCreated =
        (firstRun?.stats as { familyCreated?: boolean } | null)?.familyCreated ?? true; // 旧数据缺标记时按新建处理（行为同前）
      const [memberCount, itemCount] = await Promise.all([
        db.familyMember.count({ where: { familyId: family.id } }),
        db.item.count({ where: { familyId: family.id } }),
      ]);
      if (familyCreated && memberCount === 0 && itemCount === 0) {
        await db.family.delete({ where: { id: family.id } }).catch(() => undefined);
        deletedRows.family = 1;
        log(`  删除本次导入创建的空家庭 ${family.id}`);
      } else if (!familyCreated) {
        log(`  家庭 ${family.id} 是目标端既有家庭（--target-family），保留家庭本身（剩余 ${memberCount} 成员/${itemCount} 条目）`);
      } else {
        log(`  家庭 ${family.id} 仍有 ${memberCount} 成员/${itemCount} 条目，保留家庭本身`);
      }
    }
  }

  // 媒体文件还原：回滚到「最早一次导入之前」的快照
  const earliestRun = await db.$transaction(async (tx) => {
    const first = await tx.migrationRun.findFirst({
      where: { bundleId },
      orderBy: { startedAt: 'asc' },
    });
    return first;
  }).catch(() => null);
  const effectiveSnapshotRun = earliestRun?.id ?? runId;
  const meta = await readSnapshotMeta(effectiveSnapshotRun);
  let filesRestored = 0;
  let filesRemoved = 0;
  const beforeHashes = new Map(meta?.files.map((f) => [f.rel, f]) ?? []);

  const storagePrefix = path.posix.join('families', targetFamilyId);
  const after = await walkFiles(targetStorageRoot, storagePrefix).catch(() => []);
  for (const f of after) {
    const before = beforeHashes.get(f.rel);
    if (!before) {
      // 导入后新增的文件：存储按家庭隔离，可安全删除
      await fsp.rm(f.abs, { force: true });
      filesRemoved += 1;
      continue;
    }
    const currentHash = await sha256File(f.abs).catch(() => null);
    if (currentHash !== before.sha256) {
      const snapFile = path.join(snapshotDir(effectiveSnapshotRun), 'storage', f.rel);
      await fsp.mkdir(path.dirname(f.abs), { recursive: true });
      await fsp.copyFile(snapFile, f.abs);
      filesRestored += 1;
    }
  }
  for (const f of meta?.files ?? []) {
    const target = storageAbs(targetStorageRoot, f.rel);
    try {
      await fsp.access(target);
    } catch {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(path.join(snapshotDir(effectiveSnapshotRun), 'storage', f.rel), target);
      filesRestored += 1;
    }
  }
  log(`媒体文件：还原 ${filesRestored} 个，移除新增 ${filesRemoved} 个`);

  await db.migrationRecord.deleteMany({ where: { bundleId } });
  await db.migrationRun.deleteMany({ where: { bundleId } });

  return { deletedRows, filesRestored, filesRemoved, runId, targetFamilyId };
}
