import path from 'node:path';
import fsp from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import type { BundleManifest, ImportStats } from './types';
import type { EntityType } from './types';
import { iterRows, storageRoot } from './bundle';
import { storageAbs } from './clients';
import { IdRemapper } from './remap';
import { scalarFieldNames, ENTITY_MODEL } from './schemaMeta';
import { copyFileWithHash } from './hash';
import { createPreSnapshot, snapshotDir } from './snapshot';

export interface ImportOptions {
  dryRun?: boolean;
  /**
   * 把数据导入到目标端指定的已有家庭（而不是新建）。
   * 迁移前该家庭必须没有同名条目冲突；回滚时家庭本身保留，只删除迁进来的数据。
   */
  targetFamilyId?: string;
  onProgress?: (msg: string) => void;
}

export interface ImportResult {
  runId: string;
  targetFamilyId: string;
  stats: ImportStats;
  snapshotDir: string;
}

type Log = (msg: string) => void;
type DbDelegate = {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
};

/** 复合主键实体没有 id 列，台账用固定规则拼 sourceId/targetId。 */
function ledgerKey(entity: EntityType, row: Record<string, unknown>): string {
  if (entity === 'settings') return `${String(row.familyId)}|${String(row.key)}`;
  if (entity === 'shareLinkItems') return `${String(row.shareLinkId)}|${String(row.itemId)}`;
  return String(row.id);
}

/**
 * 目标端导入，保证三件事：
 *   1. 标识重映射 —— 源端所有 ID 经 IdRemapper 改写，新旧 ID 对应关系全部落台账；
 *   2. 幂等重放 —— 每行先查台账，已导入则跳过并复用旧映射；行级事务
 *      （插入数据 + 写台账）保证中途失败后重跑不会留下半成品；
 *   3. 可回滚 —— 导入前对目标家庭存储做快照（续跑复用最早批次的快照），
 *      批次信息落 migration_runs，失败可整包回到迁移前。
 */
export async function importFamily(
  db: PrismaClient,
  targetStorageRoot: string,
  bundleDir: string,
  manifest: BundleManifest,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const log = opts.onProgress ?? (() => undefined);
  const dryRun = !!opts.dryRun;

  const priorRun = await db.migrationRun.findFirst({
    where: { bundleId: manifest.bundleId },
    orderBy: { startedAt: 'desc' },
  });
  const run = dryRun
    ? ({ id: `dryrun-${Date.now()}`, targetFamily: priorRun?.targetFamily ?? null } as never)
    : await db.migrationRun.create({
        data: {
          bundleId: manifest.bundleId,
          sourceFamily: manifest.source.familyId,
          targetFamily: priorRun?.targetFamily ?? null,
          status: 'running',
        },
      });
  const runId: string = run.id;
  log(`迁移批次：${runId}${dryRun ? '（dry-run，不写库）' : ''}`);

  // ---- Phase 0：用户先行（family.createdBy 依赖用户映射；邮箱相同则合并）----
  const userMap = new Map<string, string>();
  const stats: ImportStats = {
    inserted: {},
    skipped: {},
    mergedUsers: [],
    mediaCopied: 0,
    mediaVerified: 0,
    mediaBytes: 0,
  };

  for await (const row of iterRows(bundleDir, 'users')) {
    const sourceId = String(row.id);
    const ledger = dryRun
      ? null
      : await db.migrationRecord.findUnique({
          where: { bundleId_entityType_sourceId: { bundleId: manifest.bundleId, entityType: 'users', sourceId } },
        });
    if (ledger) {
      userMap.set(sourceId, ledger.targetId);
      stats.skipped.users = (stats.skipped.users ?? 0) + 1;
      continue;
    }
    const existing = dryRun ? null : await db.user.findUnique({ where: { email: String(row.email) } });
    let targetId: string;
    if (existing) {
      targetId = existing.id;
      stats.mergedUsers.push({ sourceId, email: String(row.email), targetId });
      log(`  用户合并：${String(row.email)} → 既有账号 ${targetId}（保留目标端密码与资料）`);
    } else if (dryRun) {
      targetId = `dry-user-${sourceId.slice(0, 8)}`;
    } else {
      const fields = scalarData('users', row);
      const created = await db.user.create({ data: fields as never });
      targetId = String((created as { id: string }).id);
    }
    userMap.set(sourceId, targetId);
    stats.inserted.users = (stats.inserted.users ?? 0) + 1;
    if (!dryRun) {
      await db.migrationRecord.create({
        data: {
          bundleId: manifest.bundleId,
          entityType: 'users',
          sourceId,
          targetId,
          runId,
        },
      });
    }
  }
  log(`用户：导入/合并 ${stats.inserted.users ?? 0}，跳过 ${stats.skipped.users ?? 0}`);

  // ---- Phase 1：确定目标家庭（续跑取台账；否则用真实 cuid 新建）----
  let targetFamilyId: string;
  let familyCreated = false; // 家庭是否由本次迁移新建（回滚时决定是否删除家庭本身）
  const familyLedger = dryRun
    ? null
    : await db.migrationRecord.findFirst({
        where: { bundleId: manifest.bundleId, entityType: 'family' },
      });
  if (familyLedger) {
    targetFamilyId = familyLedger.targetId;
    // 续跑：从最早批次的 stats 恢复 familyCreated 标记
    const first = await db.migrationRun.findFirst({ where: { bundleId: manifest.bundleId }, orderBy: { startedAt: 'asc' } });
    familyCreated = Boolean((first?.stats as { familyCreated?: boolean } | null)?.familyCreated);
  } else if (priorRun?.targetFamily) {
    targetFamilyId = priorRun.targetFamily;
  } else if (opts.targetFamilyId) {
    const existingFamily = await db.family.findUnique({ where: { id: opts.targetFamilyId } });
    if (!existingFamily) throw new Error(`指定的目标家庭不存在：${opts.targetFamilyId}`);
    targetFamilyId = existingFamily.id;
    familyCreated = false;
    log(`导入到指定的目标既有家庭 ${targetFamilyId}（家庭行本身不迁移）`);
    if (!dryRun) {
      await db.migrationRecord.create({
        data: { bundleId: manifest.bundleId, entityType: 'family', sourceId: manifest.source.familyId, targetId: targetFamilyId, runId },
      });
    }
  } else {
    const familyRows: Record<string, unknown>[] = [];
    for await (const row of iterRows(bundleDir, 'family')) familyRows.push(row);
    if (familyRows.length !== 1) throw new Error(`迁移包内家庭记录异常：期望 1 行，实际 ${familyRows.length} 行`);
    const familyRow = familyRows[0]!;
    const data = scalarData('family', familyRow);
    const mappedCreator = userMap.get(String(familyRow.createdBy));
    if (mappedCreator) data.createdBy = mappedCreator;
    if (dryRun) {
      targetFamilyId = `dry-family-${manifest.source.familyId.slice(0, 8)}`;
    } else {
      const created = await db.family.create({ data: data as never });
      targetFamilyId = String((created as { id: string }).id);
      familyCreated = true;
      await db.migrationRecord.create({
        data: { bundleId: manifest.bundleId, entityType: 'family', sourceId: manifest.source.familyId, targetId: targetFamilyId, runId },
      });
    }
  }
  log(`源家庭 ${manifest.source.familyId} → 目标家庭 ${targetFamilyId}`);

  const remapper = new IdRemapper(manifest.source.familyId, targetFamilyId);
  for (const [sourceId, tid] of userMap) remapper.record('users', sourceId, tid);
  if (!dryRun) {
    const all = await db.migrationRecord.findMany({ where: { bundleId: manifest.bundleId } });
    for (const r of all) remapper.preload(r.entityType, r.sourceId, r.targetId);
  }

  if (!dryRun) {
    await db.migrationRun.update({ where: { id: runId }, data: { targetFamily: targetFamilyId } });
  }

  // ---- Phase 2：迁移前媒体快照。同一 bundle 只有在「已有成功/进行中的导入」
  //               （即 family 台账已存在，属于失败续跑或幂等重放）时才复用旧快照；
  //               回滚后的重新导入必须重新拍快照，否则会误还原到更早的状态。----
  let snapDir = '';
  if (!dryRun) {
    if (familyLedger) {
      const earliest = await db.migrationRun.findFirst({
        where: { bundleId: manifest.bundleId, snapshotDir: { not: null } },
        orderBy: { startedAt: 'asc' },
      });
      if (earliest?.snapshotDir) {
        snapDir = earliest.snapshotDir;
        log(`复用最早批次的迁移前快照：${snapDir}`);
      }
    }
    if (!snapDir) {
      const snap = await createPreSnapshot(targetStorageRoot, targetFamilyId, runId, log);
      snapDir = snap.dir;
      await db.migrationRun.update({ where: { id: runId }, data: { snapshotDir: snapDir } });
    }
  }

  const problems: string[] = [];

  try {
    // ---- Phase 3：其余实体按依赖顺序导入 ----
    const order: EntityType[] = [
      'settings',
      'members',
      'invites',
      'items',
      'people',
      'media',
      'itemPeople',
      'notes',
      'itemShares',
      'versions',
      'shareLinks',
      'shareLinkItems',
      'auditLogs',
    ];

    for (const entity of order) {
      let inserted = 0;
      let skipped = 0;
      const knownKeys = new Set<string>();
      if (!dryRun) {
        const prior = await db.migrationRecord.findMany({
          where: { bundleId: manifest.bundleId, entityType: entity },
          select: { sourceId: true },
        });
        for (const p of prior) knownKeys.add(p.sourceId);
      }

      for await (const sourceRow of iterRows(bundleDir, entity)) {
        const sourceKey = ledgerKey(entity, sourceRow);
        if (knownKeys.has(sourceKey)) {
          skipped += 1;
          continue;
        }

        const rewritten = remapper.rewriteRow(entity, sourceRow);
        // 审计日志的 targetId 是无类型的松散引用，用全局映射兜一层
        if (entity === 'auditLogs' && typeof rewritten.targetId === 'string') {
          rewritten.targetId = remapper.globalLookup(rewritten.targetId as string) ?? rewritten.targetId;
        }
        const data = scalarData(entity, rewritten);

        let targetKey: string;
        if (dryRun) {
          targetKey =
            entity === 'settings'
              ? `${String(data.familyId)}|${String(data.key)}`
              : entity === 'shareLinkItems'
                ? `${String(data.shareLinkId)}|${String(data.itemId)}`
                : `dry-${sourceKey.slice(0, 10)}`;
        } else {
          targetKey = await db.$transaction(async (tx) => {
            const created = await (tx as unknown as Record<string, DbDelegate>)[ENTITY_MODEL[entity]]!.create({ data });
            const tk =
              entity === 'settings'
                ? `${String(data.familyId)}|${String(data.key)}`
                : entity === 'shareLinkItems'
                  ? `${String(data.shareLinkId)}|${String(data.itemId)}`
                  : String((created as { id?: string }).id ?? '');
            await tx.migrationRecord.create({
              data: { bundleId: manifest.bundleId, entityType: entity, sourceId: sourceKey, targetId: tk, runId },
            });
            return tk;
          });
        }

        if (entity === 'settings' || entity === 'shareLinkItems') {
          remapper.preload(entity, sourceKey, targetKey);
        } else {
          remapper.record(entity, String(sourceRow.id), targetKey);
        }
        inserted += 1;
      }

      stats.inserted[entity] = inserted;
      stats.skipped[entity] = skipped;
      log(`表 ${entity}：新增 ${inserted} 行，跳过（已导入）${skipped} 行`);
    }

    // ---- Phase 4：二阶段回填封面/头像/人物合并引用（指向后导入的 media/people）----
    await fixupLooseRefs(db, bundleDir, remapper, dryRun, log);

    // ---- Phase 5：媒体文件落盘 + 反向核对 ----
    await copyMediaFiles(db, targetStorageRoot, bundleDir, manifest, remapper, stats, dryRun, log);

    if (!dryRun) {
      (stats as ImportStats & { familyCreated?: boolean }).familyCreated = familyCreated;
      await db.migrationRun.update({
        where: { id: runId },
        data: { status: 'done', stats: stats as never, problems, finishedAt: new Date() },
      });
    } else {
      log('dry-run 完成：未写入任何数据。');
    }
  } catch (err) {
    if (!dryRun) {
      await db.migrationRun
        .update({
          where: { id: runId },
          data: {
            status: 'failed',
            stats: stats as never,
            problems: [...problems, (err as Error).message],
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }
    throw err;
  }

  return { runId, targetFamilyId, stats, snapshotDir: snapDir };
}

/**
 * 只保留 Prisma 模型声明过的标量/枚举字段，BigInt/Decimal/Date 保持 serialize 还原出的形态。
 * 默认丢弃源端主键 id —— 目标端必须生成新标识，新旧 ID 的对应关系走台账。
 * 调用方需要显式指定 id（family 用预映射的目标家庭 ID）时传 keepId。
 */
function scalarData(
  entity: EntityType,
  row: Record<string, unknown>,
  opts: { keepId?: boolean } = {},
): Record<string, unknown> {
  const allowed = new Set(scalarFieldNames(entity));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!allowed.has(k)) continue;
    if (k === 'id' && !opts.keepId) continue;
    out[k] = v;
  }
  return out;
}

async function fixupLooseRefs(
  db: PrismaClient,
  bundleDir: string,
  remapper: IdRemapper,
  dryRun: boolean,
  log: Log,
): Promise<void> {
  if (dryRun) return;

  let itemFixes = 0;
  for await (const row of iterRows(bundleDir, 'items')) {
    if (typeof row.coverMediaId !== 'string') continue;
    const targetItem = remapper.lookup('items', String(row.id));
    const targetMedia = remapper.lookup('media', String(row.coverMediaId));
    if (targetItem && targetMedia) {
      await db.item.update({ where: { id: targetItem }, data: { coverMediaId: targetMedia } });
      itemFixes += 1;
    }
  }

  let personFixes = 0;
  for await (const row of iterRows(bundleDir, 'people')) {
    const targetPerson = remapper.lookup('people', String(row.id));
    if (!targetPerson) continue;
    const data: { avatarMediaId?: string | null; mergedIntoId?: string | null } = {};
    if (typeof row.avatarMediaId === 'string') {
      data.avatarMediaId = remapper.lookup('media', String(row.avatarMediaId));
    }
    if (typeof row.mergedIntoId === 'string') {
      data.mergedIntoId = remapper.lookup('people', String(row.mergedIntoId));
    }
    if (Object.keys(data).length > 0) {
      await db.person.update({ where: { id: targetPerson }, data });
      personFixes += 1;
    }
  }
  log(`二阶段引用回填：条目封面 ${itemFixes} 处，人物头像/合并 ${personFixes} 处`);
}

async function copyMediaFiles(
  db: PrismaClient,
  targetStorageRoot: string,
  bundleDir: string,
  manifest: BundleManifest,
  remapper: IdRemapper,
  stats: ImportStats,
  dryRun: boolean,
  log: Log,
): Promise<void> {
  const sourceMediaRoot = storageRoot(bundleDir);
  const keyFields = ['storageKey', 'thumbKey', 'largeKey', 'transcodeKey', 'waveformKey'] as const;

  // 以迁移包清单为权威来源逐文件复制；内容寻址 + 家庭前缀隔离，天然去重
  for (const sf of manifest.storageFiles) {
    if (!sf.rel.startsWith(remapper.storagePrefixFrom)) continue;
    const targetRel = remapper.storagePrefixTo + sf.rel.slice(remapper.storagePrefixFrom.length);
    const targetAbs = storageAbs(targetStorageRoot, targetRel);

    let reuse = false;
    try {
      const st = await fsp.stat(targetAbs);
      reuse = st.size === sf.size;
    } catch {
      reuse = false;
    }

    if (reuse) {
      stats.mediaVerified += 1;
      continue;
    }
    if (dryRun) {
      stats.mediaCopied += 1;
      stats.mediaBytes += sf.size;
      continue;
    }

    const srcAbs = path.join(sourceMediaRoot, sf.rel);
    const { sha256, bytes } = await copyFileWithHash(srcAbs, targetAbs);
    if (sha256 !== sf.sha256) throw new Error(`媒体复制后哈希不一致：${sf.rel}`);
    stats.mediaCopied += 1;
    stats.mediaBytes += bytes;
  }

  // 反向核对：目标库里每条媒体记录引用的 key 必须真实存在
  const mediaRows = dryRun
    ? []
    : await db.itemMedia.findMany({
        where: { item: { familyId: remapper.targetFamilyId } },
        select: { id: true, storageKey: true, thumbKey: true, largeKey: true, transcodeKey: true, waveformKey: true },
      });
  let missing = 0;
  for (const m of mediaRows) {
    for (const f of keyFields) {
      const key = m[f];
      if (!key) continue;
      try {
        await fsp.access(storageAbs(targetStorageRoot, key));
      } catch {
        missing += 1;
        log(`  媒体 ${m.id} 缺少文件 ${f}=${key}`);
      }
    }
  }
  if (missing > 0) throw new Error(`${missing} 个媒体文件落盘缺失，导入判定失败（可执行 migrate:rollback 回滚）`);

  log(`媒体文件：新复制 ${stats.mediaCopied} 个，已存在复用 ${stats.mediaVerified} 个`);
}
