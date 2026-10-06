/**
 * 端到端集成测试（内嵌 PGlite，每个用例独立临时目录）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect, initSchema, type Db } from './db.js';
import { exportFamily } from './export.js';
import { preflight } from './preflight.js';
import { applyBundle, rollback } from './apply.js';
import { verifyTarget } from './verify.js';
import { loadBundle, readAllRows } from './bundle.js';
import { newId, newMigrationId, sha256Hex } from './ids.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Instance {
  db: Db;
  storage: string;
  instanceId: string;
}

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hm-test-'));
});
afterEach(async () => {
  // PGlite 实例由各用例自行 close；这里尽力清理临时目录
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

async function instance(name: string, instanceId = `inst_${name}`): Promise<Instance> {
  const db = await connect(`pglite://${path.join(root, name)}`);
  await initSchema(db);
  await db.query('insert into migrator_instances (instance_id) values ($1)', [instanceId]);
  const storage = path.join(root, `${name}-storage`);
  await fsp.mkdir(storage, { recursive: true });
  return { db, storage, instanceId };
}

/** 造一个最小但完整的家庭：owner + family + item + media（真实字节） */
async function seedFamily(ins: Instance, familyName = '测试家庭') {
  const ownerId = newId();
  const familyId = newId();
  const itemId = newId();
  const mediaId = newId();
  const sha = sha256Hex(PNG);
  const key = `families/${familyId}/objects/${sha.slice(0, 2)}/${sha}.png`;
  await fsp.mkdir(path.join(ins.storage, path.dirname(key)), { recursive: true });
  await fsp.writeFile(path.join(ins.storage, key), PNG);

  await ins.db.transaction(async (tx) => {
    await tx.query(
      `insert into users (id,email,password_hash,display_name,created_at,updated_at)
       values ($1,'u@example.com','h','U',now(),now())`,
      [ownerId],
    );
    await tx.query(
      `insert into families (id,name,created_by,created_at,updated_at)
       values ($1,$2,$3,now(),now())`,
      [familyId, familyName, ownerId],
    );
    await tx.query(
      `insert into family_members (id,family_id,user_id,role,joined_at)
       values ($1,$2,$3,'owner',now())`,
      [newId(), familyId, ownerId],
    );
    await tx.query(
      `insert into items (id,family_id,title,category,status,tags,sort_at,created_by,created_at,updated_at)
       values ($1,$2,'物品','other','published',$3,now(),$4,now(),now())`,
      [itemId, familyId, ['标签1', '标签2'], ownerId],
    );
    await tx.query(
      `insert into item_media (id,item_id,kind,status,storage_key,sha256,mime_type,byte_size,
        original_name,sort_order,created_by,created_at)
       values ($1,$2,'image','ready',$3,$4,'image/png',$5,'a.png',0,$6,now())`,
      [mediaId, itemId, key, sha, PNG.length, ownerId],
    );
  });
  return { ownerId, familyId, itemId, mediaId, sha, key };
}

async function runMigration(src: Instance, tgt: Instance, familyId: string, extra: Record<string, unknown> = {}) {
  const bundleDir = path.join(root, 'bundle');
  await exportFamily(src.db, {
    bundleDir,
    familyId,
    sourceInstanceId: src.instanceId,
    storageRoot: src.storage,
  });
  const { manifest } = await loadBundle(bundleDir);
  const rowsByTable = await readAllRows(bundleDir);
  const migrationId = newMigrationId();
  const pre = await preflight(tgt.db, { bundleDir, migrationId });
  expect(pre.ok).toBe(true);
  const stateDir = path.join(root, 'state', migrationId);
  const report = await applyBundle(tgt.db, {
    bundleDir,
    manifest,
    rowsByTable,
    migrationId,
    sourceInstanceId: src.instanceId,
    targetStorageRoot: tgt.storage,
    stateDir,
    conflicts: pre.conflicts,
    ...extra,
  });
  const ver = await verifyTarget(tgt.db, { manifest, rowsByTable, migrationId, targetStorageRoot: tgt.storage });
  return { bundleDir, manifest, rowsByTable, migrationId, stateDir, report, ver, pre };
}

describe('跨实例迁移', () => {
  it('全量导出 → 校验 → 应用 → 对账 全链路通过', async () => {
    const src = await instance('source');
    const tgt = await instance('target');
    const { familyId } = await seedFamily(src);

    const r = await runMigration(src, tgt, familyId);
    expect(r.report.status).toBe('done');
    expect(r.report.stats.families.inserted).toBe(1);
    expect(r.report.stats.items.inserted).toBe(1);
    expect(r.report.mediaCopied).toBe(1);
    expect(r.ver.ok).toBe(true);
    expect(r.ver.checkedMedia).toBe(1);

    // 目标端 tags 数组、媒体路径都正确
    const item = await tgt.db.queryOne<{ title: string; tags: string[]; family_id: string }>(
      `select title, tags, family_id from items limit 1`,
    );
    expect(item?.title).toBe('物品');
    expect(item?.tags).toEqual(['标签1', '标签2']);
    expect(item?.family_id).not.toBe(familyId); // 标识已重映射

    await src.db.close();
    await tgt.db.close();
  });

  it('同一 migrationId 重放是幂等的：不产生重复行，verify 仍通过', async () => {
    const src = await instance('source');
    const tgt = await instance('target');
    const { familyId } = await seedFamily(src);
    const r = await runMigration(src, tgt, familyId);

    const pre2 = await preflight(tgt.db, { bundleDir: r.bundleDir, migrationId: r.migrationId, allowDone: true });
    expect(pre2.ok).toBe(true);
    const report2 = await applyBundle(tgt.db, {
      bundleDir: r.bundleDir,
      manifest: r.manifest,
      rowsByTable: r.rowsByTable,
      migrationId: r.migrationId,
      sourceInstanceId: src.instanceId,
      targetStorageRoot: tgt.storage,
      stateDir: r.stateDir,
      conflicts: pre2.conflicts,
    });
    expect(report2.status).toBe('done');
    expect(await tgt.db.queryOne(`select count(*)::int as n from families`)).toMatchObject({ n: 1 });
    expect(await tgt.db.queryOne(`select count(*)::int as n from items`)).toMatchObject({ n: 1 });
    const ver2 = await verifyTarget(tgt.db, {
      manifest: r.manifest,
      rowsByTable: r.rowsByTable,
      migrationId: r.migrationId,
      targetStorageRoot: tgt.storage,
    });
    expect(ver2.ok).toBe(true);

    await src.db.close();
    await tgt.db.close();
  });

  it('天然键冲突（邀请码）触发级联跳过：invite 与其从属均不入目标端', async () => {
    const src = await instance('source');
    const tgt = await instance('target');
    const { familyId, ownerId } = await seedFamily(src);

    // 源端再加一个邀请
    const codeHash = 'duplicate-code';
    await src.db.query(
      `insert into invites (id,family_id,code_hash,role,expires_at,created_by,created_at)
       values ($1,$2,$3,'viewer','2027-01-01T00:00:00Z',$4,now())`,
      [newId(), familyId, codeHash, ownerId],
    );
    // 目标端预置同 code_hash 的邀请（挂在目标端另一个家庭上）
    const otherOwner = newId();
    const otherFamily = newId();
    await tgt.db.query(`insert into users (id,email,password_hash,display_name,created_at,updated_at)
      values ($1,'x@y.z','h','X',now(),now())`, [otherOwner]);
    await tgt.db.query(`insert into families (id,name,created_by,created_at,updated_at)
      values ($1,'目标端原有家庭',$2,now(),now())`, [otherFamily, otherOwner]);
    await tgt.db.query(`insert into invites (id,family_id,code_hash,role,expires_at,created_by,created_at)
      values ($1,$2,$3,'viewer','2027-01-01T00:00:00Z',$4,now())`,
      [newId(), otherFamily, codeHash, otherOwner]);

    const r = await runMigration(src, tgt, familyId);
    expect(r.pre.conflicts.some((c) => c.table === 'invites' && c.policy === 'skip')).toBe(true);
    expect(r.report.status).toBe('done');
    expect(r.report.stats.invites.skipped).toBe(1);
    // 目标端仍只有原来那一条邀请
    const n = await tgt.db.queryOne(`select count(*)::int as n from invites where code_hash = $1`, [codeHash]);
    expect(n).toMatchObject({ n: 1 });

    await src.db.close();
    await tgt.db.close();
  });

  it('用户邮箱冲突采用目标端既有账号（adopt），其他表外键指向它', async () => {
    const src = await instance('source');
    const tgt = await instance('target');
    const { familyId } = await seedFamily(src);

    const existingId = newId();
    await tgt.db.query(
      `insert into users (id,email,password_hash,display_name,created_at,updated_at)
       values ($1,'u@example.com','target-hash','目标账号',now(),now())`,
      [existingId],
    );

    const r = await runMigration(src, tgt, familyId);
    const conflict = r.pre.conflicts.find((c) => c.table === 'users');
    expect(conflict?.policy).toBe('adopt');
    expect(conflict?.targetId).toBe(existingId);
    expect(r.report.stats.users.adopted).toBe(1);
    expect(r.ver.ok).toBe(true);

    // family_members.created_by 链路之外：成员的 user_id 必须指向 adopted 账号
    const member = await tgt.db.queryOne<{ user_id: string }>(
      `select user_id from family_members limit 1`,
    );
    expect(member?.user_id).toBe(existingId);
    expect(await tgt.db.queryOne(`select count(*)::int as n from users where email='u@example.com'`)).toMatchObject({ n: 1 });

    await src.db.close();
    await tgt.db.close();
  });

  it('失败后自动回滚：跨批次已提交的行也按快照删除，run 标记 rolled_back', async () => {
    const src = await instance('source');
    const tgt = await instance('target');
    const { familyId } = await seedFamily(src);
    // bundle 共 4 行（users/families/members/items/media=5），在第 3 行注入失败、每批 1 行
    const r = await runMigration(src, tgt, familyId, { failAfter: 3, batchSize: 1 });
    expect(r.report.status).toBe('rolled_back');
    expect(await tgt.db.queryOne(`select count(*)::int as n from families`)).toMatchObject({ n: 0 });
    expect(await tgt.db.queryOne(`select count(*)::int as n from users`)).toMatchObject({ n: 0 });
    const run = await tgt.db.queryOne<{ status: string }>(
      `select status from migrator_runs where migration_id = $1`,
      [r.migrationId],
    );
    expect(run?.status).toBe('rolled_back');
    // 回滚后可以重新迁移成功
    const r2 = await runMigration(src, tgt, familyId);
    expect(r2.report.status).toBe('done');
    expect(r2.ver.ok).toBe(true);

    await src.db.close();
    await tgt.db.close();
  });

  it('no-auto-rollback 保留现场，修复后续跑能完成（断点续跑）', async () => {
    const src = await instance('source');
    const tgt = await instance('target');
    const { familyId } = await seedFamily(src);

    const bundleDir = path.join(root, 'bundle');
    await exportFamily(src.db, { bundleDir, familyId, sourceInstanceId: src.instanceId, storageRoot: src.storage });
    const { manifest } = await loadBundle(bundleDir);
    const rowsByTable = await readAllRows(bundleDir);
    const migrationId = newMigrationId();
    const stateDir = path.join(root, 'state', migrationId);

    // 第一次：第 2 行失败、不自动回滚（每批 1 行 → 第 1 行 users 已提交）
    let pre = await preflight(tgt.db, { bundleDir, migrationId });
    const failed = await applyBundle(tgt.db, {
      bundleDir, manifest, rowsByTable, migrationId,
      sourceInstanceId: src.instanceId, targetStorageRoot: tgt.storage, stateDir,
      conflicts: pre.conflicts, failAfter: 2, batchSize: 1, autoRollback: false,
    });
    expect(failed.status).toBe('failed');

    // 第二次：去掉注入失败，断点续跑
    pre = await preflight(tgt.db, { bundleDir, migrationId, allowDone: true });
    const done = await applyBundle(tgt.db, {
      bundleDir, manifest, rowsByTable, migrationId,
      sourceInstanceId: src.instanceId, targetStorageRoot: tgt.storage, stateDir,
      conflicts: pre.conflicts, batchSize: 1,
    });
    expect(done.status).toBe('done');
    const ver = await verifyTarget(tgt.db, { manifest, rowsByTable, migrationId, targetStorageRoot: tgt.storage });
    expect(ver.ok).toBe(true);

    await src.db.close();
    await tgt.db.close();
  });

  it('覆盖目标端同名媒体文件时回滚会还原旧文件字节', async () => {
    const src = await instance('source');
    const tgt = await instance('target');
    const { familyId, sha, key } = await seedFamily(src);

    // 先迁移一次
    const r = await runMigration(src, tgt, familyId);

    // 在目标端把该媒体文件改成“别的字节”，再用新 migrationId 重新迁移同一份数据
    // （路径由 migrationId 派生，不会覆盖；改为手工构造覆盖场景：直接写目标路径）
    const newFamilyId = Object.values(r.report.stats); // placeholder
    void newFamilyId;
    const idMapRow = await tgt.db.queryOne<{ target_id: string }>(
      `select target_id from migrator_id_map where migration_id=$1 and table_name='families' limit 1`,
      [r.migrationId],
    );
    const targetKey = `families/${idMapRow!.target_id}/objects/${sha.slice(0, 2)}/${sha}.png`;
    expect(targetKey).not.toBe(key);
    const abs = path.join(tgt.storage, targetKey);
    const oldBytes = Buffer.from('OLD-CONTENT-BYTES-ON-TARGET');
    await fsp.writeFile(abs, oldBytes);

    // rollback 上一次迁移不应动文件（它是 copied 状态，删除即可验证另一条路径；
    // 这里直接验证 overwritten 路径：伪造一次覆盖快照再回滚）
    const migFake = newMigrationId();
    const stateFake = path.join(root, 'state', migFake);
    await fsp.mkdir(path.join(stateFake, 'media-backup', path.dirname(targetKey)), { recursive: true });
    const backupPath = path.join(stateFake, 'media-backup', targetKey);
    await fsp.copyFile(abs, backupPath); // 备份旧字节
    await fsp.writeFile(abs, PNG); // 模拟迁移覆盖
    await tgt.db.query(`insert into migrator_runs (migration_id,source_instance_id,source_family_id,bundle_fingerprint,status)
      values ($1,'x',$2,'f','running')`, [migFake, idMapRow!.target_id]);
    await tgt.db.query(
      `insert into migrator_media_snapshots (migration_id,target_key,action,old_blob_path)
       values ($1,$2,'overwritten',$3)`,
      [migFake, targetKey, path.relative(stateFake, backupPath)],
    );
    await rollback(tgt.db, {
      migrationId: migFake,
      targetStorageRoot: tgt.storage,
      stateDir: stateFake,
    });
    expect(await fsp.readFile(abs)).toEqual(oldBytes);

    await src.db.close();
    await tgt.db.close();
  });

  it('导出包被篡改时 validate / apply 拒绝', async () => {
    const src = await instance('source');
    const tgt = await instance('target');
    const { familyId } = await seedFamily(src);
    const bundleDir = path.join(root, 'bundle');
    await exportFamily(src.db, { bundleDir, familyId, sourceInstanceId: src.instanceId, storageRoot: src.storage });

    // 篡改某个数据文件但不改清单
    const f = path.join(bundleDir, 'data', 'items.json');
    const tampered = (await fsp.readFile(f, 'utf8')).replace('物品', '被篡改的物品');
    await fsp.writeFile(f, tampered);

    const migrationId = newMigrationId();
    await expect(preflight(tgt.db, { bundleDir, migrationId })).rejects.toThrow(/校验失败|sha256/);

    await src.db.close();
    await tgt.db.close();
  });

  it('拒绝回灌源实例自身（instanceId 相同）', async () => {
    const src = await instance('same');
    const { familyId } = await seedFamily(src);
    const bundleDir = path.join(root, 'bundle');
    await exportFamily(src.db, { bundleDir, familyId, sourceInstanceId: src.instanceId, storageRoot: src.storage });

    const pre = await preflight(src.db, { bundleDir, migrationId: newMigrationId() });
    expect(pre.ok).toBe(false);
    expect(pre.errors.join(' ')).toMatch(/同一个实例/);

    await src.db.close();
  });

  it('空家庭（无成员无物品）也能完整导出迁移并对账', async () => {
    const src = await instance('source');
    const tgt = await instance('target');
    const ownerId = newId();
    const familyId = newId();
    await src.db.query(
      `insert into users (id,email,password_hash,display_name,created_at,updated_at)
       values ($1,'e@example.com','h','E',now(),now())`,
      [ownerId],
    );
    await src.db.query(
      `insert into families (id,name,created_by,created_at,updated_at)
       values ($1,'空家庭',$2,now(),now())`,
      [familyId, ownerId],
    );
    const r = await runMigration(src, tgt, familyId);
    expect(r.report.status).toBe('done');
    expect(r.report.stats.families.inserted).toBe(1);
    expect(r.report.mediaCopied).toBe(0);
    expect(r.ver.ok).toBe(true);
    await src.db.close();
    await tgt.db.close();
  });

  it('导出的引用闭包不完整时报错（硬外键悬空）', async () => {
    const ins = await instance('lonely', 'inst_lonely');
    const familyId = newId();
    // 直接插入一个 created_by 指向不存在用户的家庭（绕过应用层）
    await ins.db.query(`insert into families (id,name,created_by,created_at,updated_at)
      values ($1,'F','missing-user',now(),now())`, [familyId]);
    const bundleDir = path.join(root, 'bundle-bad');
    await expect(
      exportFamily(ins.db, { bundleDir, familyId, sourceInstanceId: ins.instanceId, storageRoot: ins.storage }),
    ).rejects.toThrow(/引用不完整/);
    await ins.db.close();
  });
});
