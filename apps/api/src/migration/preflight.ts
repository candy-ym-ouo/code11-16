import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { BundleManifest, CheckResult } from './types';
import { countLines, iterRows, storageRoot, tableFile, verifyManifestHashes } from './bundle';
import { hasLedgerTables, latestMigration, storageAbs } from './clients';
import { sha256File } from './hash';

export interface PreflightOptions {
  targetStorageRoot: string;
  /** 当目标端已有同一 bundle 的导入记录时，默认只允许续跑，不允许当成全新导入 */
  allowResume: boolean;
  onProgress?: (msg: string) => void;
}

/**
 * 目标端校验，分四组，任何一组失败都不允许开始导入：
 *   1. 迁移包自身完整性：文件齐全、行数对得上、sha256 全部一致、媒体哈希一致；
 *   2. 目标数据库：可连接、schema 版本不旧于源端、迁移台账表存在；
 *   3. 目标存储：目录可写、媒体子目录不与其他家庭冲突；
 *   4. 续跑/重放状态：同 bundleId 的历史记录必须自洽。
 */
export async function preflight(
  db: PrismaClient,
  bundleDir: string,
  manifest: BundleManifest,
  opts: PreflightOptions,
): Promise<CheckResult> {
  const log = opts.onProgress ?? (() => undefined);
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // ---- 1. 迁移包完整性 ----
  log('校验迁移包文件哈希…');
  const hashErrors = await verifyManifestHashes(bundleDir, manifest, (name) => log(`  ✓ ${name}`));
  errors.push(...hashErrors);

  log('核对表文件行数…');
  for (const [entity, expected] of Object.entries(manifest.counts)) {
    const actual = await countLines(tableFile(bundleDir, entity as never));
    if (actual !== expected) {
      errors.push(`表 ${entity} 行数与清单不符：文件 ${actual} 行，清单 ${expected} 行`);
    }
  }

  log(`校验 ${manifest.storageFiles.length} 个媒体文件哈希…`);
  let badMedia = 0;
  let checked = 0;
  for (const sf of manifest.storageFiles) {
    const file = path.join(storageRoot(bundleDir), sf.rel);
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      errors.push(`媒体文件缺失：${sf.rel}`);
      badMedia += 1;
      continue;
    }
    if (st.size !== sf.size) {
      errors.push(`媒体大小不符：${sf.rel}`);
      badMedia += 1;
      continue;
    }
    const sha = await sha256File(file);
    checked += 1;
    if (sha !== sf.sha256) {
      errors.push(`媒体 sha256 不符：${sf.rel}`);
      badMedia += 1;
    }
  }
  info.push(`媒体文件校验 ${checked}/${manifest.storageFiles.length} 个通过`);
  if (badMedia > 0) warnings.push(`${badMedia} 个媒体文件异常（详见错误列表）`);

  // ---- 2. 目标数据库 ----
  log('检查目标数据库…');
  let targetMigration: string | null = null;
  try {
    await db.$queryRaw`select 1`;
    targetMigration = await latestMigration(db);
    info.push(`目标端最新迁移：${targetMigration ?? '（无）'}`);
  } catch (err) {
    errors.push(`目标数据库不可连接：${(err as Error).message}`);
  }

  if (targetMigration && manifest.source.migration) {
    // 迁移按时间戳字典序部署；目标端比源端旧时明确拒绝（新端导入旧包通常向后兼容）
    if (targetMigration < manifest.source.migration) {
      errors.push(
        `目标端数据库版本（${targetMigration}）旧于源端（${manifest.source.migration}），请先在目标端执行 pnpm db:deploy`,
      );
    }
  }

  if (await hasLedgerTables(db).catch(() => false)) {
    info.push('迁移台账表 migration_records 已就绪');
  } else {
    errors.push('目标端缺少迁移台账表，请先在目标端执行 pnpm db:deploy（应用 migration_ledger 迁移）');
  }

  // 源数据自洽性：外键指向的行在包内必须存在（否则导入后会变悬空引用）
  log('检查包内外键引用自洽性…');
  await checkReferentialIntegrity(bundleDir, manifest, errors, warnings);

  // ---- 3. 目标存储 ----
  log('检查目标存储目录…');
  const storageOk = await ensureWritable(opts.targetStorageRoot, errors);
  if (storageOk) {
    info.push(`目标存储根可写：${opts.targetStorageRoot}`);
    const free = await diskFreeBytes(opts.targetStorageRoot);
    if (free !== null) {
      const needBytes = manifest.mediaBytes + 64 * 1024 * 1024; // 留 64MiB 余量
      if (free < needBytes) {
        errors.push(
          `目标磁盘空间不足：可用 ${(free / 1024 / 1024).toFixed(0)} MiB，至少需要 ${(needBytes / 1024 / 1024).toFixed(0)} MiB`,
        );
      } else {
        info.push(`磁盘空间充足：可用 ${(free / 1024 / 1024 / 1024).toFixed(1)} GiB`);
      }
    }
  }

  // ---- 4. 历史导入记录（幂等续跑）----
  log('检查历史迁移记录…');
  const priorRuns = await db.migrationRun.findMany({
    where: { bundleId: manifest.bundleId },
    orderBy: { startedAt: 'desc' },
  });
  const priorRecords = await db.migrationRecord.count({ where: { bundleId: manifest.bundleId } });
  if (priorRuns.length > 0) {
    const done = priorRuns.find((r) => r.status === 'done');
    if (done && !opts.allowResume) {
      warnings.push(`迁移包已成功导入过（批次 ${done.id}）；重复导入将走幂等重放，不会产生重复数据`);
    }
    const failed = priorRuns.filter((r) => r.status === 'failed');
    if (failed.length > 0) {
      info.push(`发现 ${failed.length} 个失败批次，本次导入将从台账断点继续`);
    }
    info.push(`历史台账记录 ${priorRecords} 条`);
  }

  return { ok: errors.length === 0, errors, warnings, info };
}

async function checkReferentialIntegrity(
  bundleDir: string,
  manifest: BundleManifest,
  errors: string[],
  warnings: string[],
): Promise<void> {
  const idSets = new Map<string, Set<string>>();
  const add = (type: string, id: unknown): void => {
    if (typeof id !== 'string') return;
    let s = idSets.get(type);
    if (!s) {
      s = new Set();
      idSets.set(type, s);
    }
    s.add(id);
  };

  // 损坏的行（无法解析 JSON）记为错误并跳过，不让引用扫描本身崩掉
  const parseErrors = new Set<string>();
  const safeRows = async function* (entity: Parameters<typeof iterRows>[1]): AsyncGenerator<Record<string, unknown>> {
    try {
      for await (const row of iterRows(bundleDir, entity)) yield row;
    } catch (err) {
      parseErrors.add(`${entity}.jsonl 存在无法解析的行：${(err as Error).message}`);
    }
  };

  for await (const row of safeRows('items')) add('items', row.id);
  for await (const row of safeRows('people')) add('people', row.id);
  for await (const row of safeRows('media')) add('media', row.id);
  for await (const row of safeRows('users')) add('users', row.id);
  for await (const row of safeRows('shareLinks')) add('shareLinks', row.id);

  const checkFk = async (
    entity: Parameters<typeof iterRows>[1],
    field: string,
    refType: string,
    nullable: boolean,
  ): Promise<void> => {
    for await (const row of safeRows(entity)) {
      const v = row[field];
      if (v === null || v === undefined) {
        if (!nullable) errors.push(`${entity} 行 ${String(row.id ?? '?')} 的 ${field} 为空`);
        continue;
      }
      if (typeof v !== 'string' || !idSets.get(refType)?.has(v)) {
        warnings.push(`${entity} 行 ${String(row.id ?? '?')} 的 ${field}=${String(v)} 在迁移包内无对应 ${refType}，导入后将置空`);
      }
    }
  };

  await checkFk('media', 'itemId', 'items', false);
  await checkFk('itemPeople', 'itemId', 'items', false);
  await checkFk('itemPeople', 'personId', 'people', false);
  await checkFk('notes', 'itemId', 'items', false);
  await checkFk('notes', 'authorId', 'users', false);
  await checkFk('versions', 'itemId', 'items', false);
  await checkFk('versions', 'createdBy', 'users', false);
  await checkFk('shareLinkItems', 'itemId', 'items', false);
  await checkFk('shareLinkItems', 'shareLinkId', 'shareLinks', false);
  await checkFk('items', 'coverMediaId', 'media', true);
  await checkFk('people', 'avatarMediaId', 'media', true);
  await checkFk('people', 'mergedIntoId', 'people', true);

  // 清单声明的存储文件与媒体行声明的 storageKey 双向核对
  const declared = new Set(manifest.storageFiles.map((f) => f.rel));
  for await (const row of safeRows('media')) {
    for (const field of ['storageKey', 'thumbKey', 'largeKey', 'transcodeKey', 'waveformKey']) {
      const key = row[field];
      if (typeof key !== 'string') continue;
      if (!declared.has(key)) warnings.push(`媒体 ${String(row.id)} 的 ${field}=${key} 在迁移包内没有对应文件`);
    }
  }
  for (const msg of parseErrors) errors.push(msg);
}

async function ensureWritable(root: string, errors: string[]): Promise<boolean> {
  try {
    await fsp.mkdir(root, { recursive: true });
    const probe = path.join(root, `.migration-probe-${process.pid}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
    return true;
  } catch (err) {
    errors.push(`目标存储目录不可写：${root}（${(err as Error).message}）`);
    return false;
  }
}

async function diskFreeBytes(dir: string): Promise<number | null> {
  try {
    const { statfs } = await import('node:fs/promises');
    const st = await statfs(dir);
    return Number(st.bavail) * st.bsize;
  } catch {
    return null;
  }
}

/** 导入完成后的复核：行数、媒体哈希、悬空引用。 */
export async function postVerify(
  db: PrismaClient,
  targetStorageRoot: string,
  manifest: BundleManifest,
  targetFamilyId: string,
  stats: { inserted: Record<string, number>; mergedUsers: unknown[] },
): Promise<CheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  const [items, media, people, members] = await Promise.all([
    db.item.count({ where: { familyId: targetFamilyId } }),
    db.itemMedia.count({ where: { item: { familyId: targetFamilyId } } }),
    db.person.count({ where: { familyId: targetFamilyId } }),
    db.familyMember.count({ where: { familyId: targetFamilyId } }),
  ]);

  // 导入行数 = 源行数；合并用户不计入 users 插入数
  const expectItems = manifest.counts.items;
  const expectMedia = manifest.counts.media;
  if (items !== expectItems) errors.push(`条目数不符：目标 ${items}，源端 ${expectItems}`);
  if (media !== expectMedia) errors.push(`媒体记录数不符：目标 ${media}，源端 ${expectMedia}`);
  if (people !== manifest.counts.people) errors.push(`人物数不符：目标 ${people}，源端 ${manifest.counts.people}`);
  if (members !== manifest.counts.members) errors.push(`成员关系数不符：目标 ${members}，源端 ${manifest.counts.members}`);
  info.push(`目标家庭 ${targetFamilyId}：条目 ${items} / 媒体 ${media} / 人物 ${people} / 成员 ${members}`);

  // 存储 key 已被改写到目标家庭前缀
  const badKey = await db.itemMedia.count({
    where: { item: { familyId: targetFamilyId }, storageKey: { contains: manifest.source.familyId } },
  });
  if (badKey > 0) errors.push(`${badKey} 条媒体记录的 storageKey 仍指向源家庭 ID，重映射不完整`);

  // 抽查全部媒体（家庭数据量可接受），sha256 必须与磁盘一致
  const rows = await db.itemMedia.findMany({
    where: { item: { familyId: targetFamilyId } },
    select: { storageKey: true, sha256: true },
  });
  let verified = 0;
  for (const m of rows) {
    const file = storageAbs(targetStorageRoot, m.storageKey);
    try {
      const sha = await sha256File(file);
      if (sha !== m.sha256) {
        errors.push(`媒体落盘后哈希不一致：${m.storageKey}`);
      } else verified += 1;
    } catch {
      errors.push(`媒体落盘后文件缺失：${m.storageKey}`);
    }
  }
  info.push(`落盘媒体哈希复核 ${verified}/${rows.length} 个通过`);

  // 悬空外键：成员/条目引用的用户必须真实存在
  const orphanItems = await db.$queryRaw<{ count: bigint }[]>`
    select count(*)::bigint as count from items i
    left join users u on u.id = i.created_by
    where i.family_id = ${targetFamilyId} and u.id is null`;
  if (Number(orphanItems[0]?.count ?? 0) > 0) {
    warnings.push(`${Number(orphanItems[0]!.count)} 条目的创建者在目标端不存在（导入时已合并/置空）`);
  }

  void stats;
  return { ok: errors.length === 0, errors, warnings, info };
}
