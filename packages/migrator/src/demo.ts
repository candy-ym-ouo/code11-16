/**
 * 端到端演示（无需任何外部服务，纯内嵌 PGlite）：
 *
 *   1. 在临时目录起两个实例：source / target，各自 init
 *   2. 源端种入一个完整家庭：用户、成员、邀请、人物（含合并自引用）、
 *      物品、媒体（真实图片字节）、故事备注、版本快照、分享链接、设置、审计日志
 *   3. export 全量导出
 *   4. validate 目标端校验（先造一个 email 冲突，演示 adopt）
 *   5. apply 迁移 + verify 对账
 *   6. 再跑一次 apply 演示幂等重放
 *   7. fail-after 注入失败演示自动回滚（第二个家庭）
 *
 * 运行：pnpm --filter @heirloom/migrator demo
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect, initSchema, type Db } from './db.js';
import { exportFamily } from './export.js';
import { preflight } from './preflight.js';
import { applyBundle } from './apply.js';
import { verifyTarget } from './verify.js';
import { loadBundle, readAllRows } from './bundle.js';
import { newId, newMigrationId, sha256Hex } from './ids.js';

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'heirloom-migrate-demo-'));
const log = (s: string) => console.log(`\x1b[36m[demo]\x1b[0m ${s}`);
const head = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/** 造一个已 init 的 PGlite 实例 */
async function makeInstance(name: string): Promise<{ db: Db; storage: string; instanceId: string }> {
  const dir = path.join(ROOT, name);
  const storage = path.join(ROOT, `${name}-storage`);
  await fsp.mkdir(storage, { recursive: true });
  const db = await connect(`pglite://${dir}`);
  await initSchema(db);
  const instanceId = `inst_demo_${name}`;
  await db.query('insert into migrator_instances (instance_id) values ($1)', [instanceId]);
  return { db, storage, instanceId };
}

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function seedSource(db: Db, storage: string): Promise<{ familyId: string; ownerId: string; mediaSha: string }> {
  const now = '2026-09-01T08:00:00.000Z';
  const ownerId = newId();
  const editorId = newId();
  const familyId = newId();
  const memberId = newId();
  const inviteId = newId();
  const personA = newId();
  const personB = newId();
  const itemId = newId();
  const mediaId = newId();
  const noteId = newId();
  const versionId = newId();
  const shareId = newId();
  const mediaSha = sha256Hex(PNG);
  const mediaKey = `families/${familyId}/objects/${mediaSha.slice(0, 2)}/${mediaSha}.png`;
  await fsp.mkdir(path.join(storage, path.dirname(mediaKey)), { recursive: true });
  await fsp.writeFile(path.join(storage, mediaKey), PNG);

  await db.transaction(async (tx) => {
    const ins = (table: string, cols: string[], vals: unknown[]) =>
      tx.query(
        `insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        vals,
      );
    await ins('users', ['id', 'email', 'password_hash', 'display_name', 'created_at', 'updated_at'], [
      ownerId, 'owner@example.com', 'hash-owner', '外婆', now, now,
    ]);
    await ins('users', ['id', 'email', 'password_hash', 'display_name', 'created_at', 'updated_at'], [
      editorId, 'editor@example.com', 'hash-editor', '舅舅', now, now,
    ]);
    await ins(
      'families',
      ['id', 'name', 'description', 'created_by', 'created_at', 'updated_at'],
      [familyId, '老屋的记忆', '三代人的旧物件', ownerId, now, now],
    );
    await ins('family_members', ['id', 'family_id', 'user_id', 'role', 'joined_at'], [
      memberId, familyId, ownerId, 'owner', now,
    ]);
    await ins('family_members', ['id', 'family_id', 'user_id', 'role', 'joined_at'], [
      newId(), familyId, editorId, 'editor', now,
    ]);
    await ins(
      'invites',
      ['id', 'family_id', 'code_hash', 'role', 'expires_at', 'created_by', 'created_at'],
      [inviteId, familyId, 'hash-code-xyz', 'viewer', '2026-12-31T00:00:00.000Z', ownerId, now],
    );
    await ins(
      'people',
      ['id', 'family_id', 'name', 'relation', 'birth_year', 'created_by', 'created_at', 'updated_at'],
      [personA, familyId, '张阿婆', '外祖母', 1928, ownerId, now, now],
    );
    await ins(
      'people',
      ['id', 'family_id', 'name', 'merged_into_id', 'created_by', 'created_at', 'updated_at'],
      [personB, familyId, '阿婆（重复档案）', personA, ownerId, now, now],
    );
    await ins(
      'items',
      ['id', 'family_id', 'title', 'category', 'status', 'visibility', 'story_text', 'tags',
       'cover_media_id', 'sort_at', 'created_by', 'created_at', 'updated_at', 'place_lat', 'place_lng'],
      [itemId, familyId, '红木柜子', 'furniture', 'published', 'family', '据说是外婆的嫁妆，1952 年迁入。',
       ['家具', '嫁妆'], mediaId, now, ownerId, now, now, 30.2741, 120.1551],
    );
    await ins(
      'item_media',
      ['id', 'item_id', 'kind', 'status', 'storage_key', 'sha256', 'mime_type', 'byte_size',
       'width', 'height', 'original_name', 'sort_order', 'created_by', 'created_at'],
      [mediaId, itemId, 'image', 'ready', mediaKey, mediaSha, 'image/png', PNG.length,
       1, 1, 'cabinet.png', 0, ownerId, now],
    );
    await ins(
      'item_people',
      ['id', 'item_id', 'person_id', 'role'],
      [newId(), itemId, personA, 'source'],
    );
    await ins(
      'item_notes',
      ['id', 'item_id', 'author_id', 'type', 'body', 'status', 'created_at'],
      [noteId, itemId, editorId, 'story', '柜子左侧有一道搬家时留下的划痕。', 'accepted', now],
    );
    await ins(
      'item_versions',
      ['id', 'item_id', 'version', 'snapshot', 'created_by', 'created_at'],
      [versionId, itemId, 1, { title: '红木柜子', tags: ['家具'] }, ownerId, now],
    );
    await ins(
      'share_links',
      ['id', 'family_id', 'token_hash', 'label', 'expires_at', 'access_count', 'created_by', 'created_at'],
      [shareId, familyId, 'hash-token-abc', '给表姐看看', '2026-12-31T00:00:00.000Z', 3, ownerId, now],
    );
    await ins('share_link_items', ['share_link_id', 'item_id'], [shareId, itemId]);
    await ins('settings', ['family_id', 'key', 'value', 'updated_at'], [
      familyId, 'theme', { primary: '#8b4513', story: `关于家庭 ${familyId} 的备注` }, now,
    ]);
    await ins(
      'audit_logs',
      ['id', 'family_id', 'actor_id', 'action', 'target_type', 'target_id', 'diff', 'created_at'],
      [newId(), familyId, ownerId, 'item.create', 'Item', itemId, { title: ['', '红木柜子'] }, now],
    );
  });
  return { familyId, ownerId, mediaSha };
}

async function main(): Promise<void> {
  head('① 准备源实例与目标实例（内嵌 PGlite，临时目录）');
  const src = await makeInstance('source');
  const tgt = await makeInstance('target');
  log(`工作目录：${ROOT}`);

  head('② 源端种入家庭档案');
  const { familyId, ownerId, mediaSha } = await seedSource(src.db, src.storage);
  log(`家庭ID=${familyId}，owner=${ownerId}，媒体sha=${mediaSha.slice(0, 16)}…`);

  // 目标端预置同邮箱用户 → 演示 adopt
  await tgt.db.query(
    `insert into users (id, email, password_hash, display_name, created_at, updated_at)
     values ($1, 'owner@example.com', 'target-hash', '本地同名账号', now(), now())`,
    [newId()],
  );
  const targetOwner = (await tgt.db.queryOne<{ id: string }>(
    `select id from users where email = 'owner@example.com'`,
  ))!;

  const bundle = path.join(ROOT, 'bundle-a');

  head('③ export：全量导出（数据 + 媒体 + 清单指纹）');
  const exp = await exportFamily(src.db, {
    bundleDir: bundle,
    familyId,
    sourceInstanceId: src.instanceId,
    storageRoot: src.storage,
  });
  log(`导出 ${exp.totalRows} 行 / ${exp.mediaCount} 个媒体对象，指纹=${exp.fingerprint.slice(0, 20)}…`);

  const { manifest } = await loadBundle(bundle);
  const rawRows = await readAllRows(bundle);

  head('④ validate：目标端导入前校验');
  const migrationId = newMigrationId();
  const pre = await preflight(tgt.db, { bundleDir: bundle, migrationId });
  if (!pre.ok) throw new Error(pre.errors.join('; '));
  for (const w of pre.warnings) console.log(`  ! ${w}`);
  const adopt = pre.conflicts.find((c) => c.table === 'users');
  log(`冲突策略：users/${adopt?.policy} → ${adopt?.targetId === targetOwner.id ? '正确指向目标端既有账号' : adopt?.targetId}`);

  head('⑤ apply：重映射标识并写入目标端');
  const stateDir = path.join(ROOT, 'state', migrationId);
  const report = await applyBundle(tgt.db, {
    bundleDir: bundle,
    manifest,
    rowsByTable: rawRows,
    migrationId,
    sourceInstanceId: src.instanceId,
    targetStorageRoot: tgt.storage,
    stateDir,
    conflicts: pre.conflicts,
  });
  for (const [t, s] of Object.entries(report.stats)) {
    if (s.total) log(`${t}: 总${s.total} 插入${s.inserted} 采用${s.adopted} 跳过${s.skipped}`);
  }

  head('⑥ verify：迁移后逐行对账 + 外键 + 媒体 sha256');
  const ver = await verifyTarget(tgt.db, {
    manifest,
    rowsByTable: rawRows,
    migrationId,
    targetStorageRoot: tgt.storage,
  });
  if (!ver.ok) throw new Error(ver.problems.join('; '));
  log(`对账通过：核对 ${ver.checkedRows} 行、${ver.checkedMedia} 个媒体对象`);

  head('⑦ 幂等重放：同一 migrationId 再 apply 一次');
  const pre2 = await preflight(
    tgt.db,
    { bundleDir: bundle, migrationId, allowDone: true },
  );
  if (!pre2.ok) throw new Error(pre2.errors.join('; '));
  const report2 = await applyBundle(tgt.db, {
    bundleDir: bundle,
    manifest,
    rowsByTable: rawRows,
    migrationId,
    sourceInstanceId: src.instanceId,
    targetStorageRoot: tgt.storage,
    stateDir,
    conflicts: pre2.conflicts,
  });
  const insertedAgain = Object.values(report2.stats).reduce((n, s) => n + s.inserted, 0);
  log(`第二次 apply 新插入 ${insertedAgain} 行（adopt/skipped 走映射复用），目标端无重复数据`);
  const familyCount = await tgt.db.queryOne<{ n: number }>(
    `select count(*)::int as n from families where name = '老屋的记忆'`,
  );
  log(`目标端同名家庭数量=${familyCount?.n}（期望 1）`);
  const ver2 = await verifyTarget(tgt.db, {
    manifest,
    rowsByTable: rawRows,
    migrationId,
    targetStorageRoot: tgt.storage,
  });
  if (!ver2.ok) throw new Error(ver2.problems.join('; '));
  log('重放后再次 verify 通过');

  head('⑧ 失败自动回滚演练：第二个家庭在第 3 行注入失败');
  const familyB = newId();
  await src.db.query(`insert into families (id, name, created_by, created_at, updated_at)
    values ($1, '第二个家', $2, now(), now())`, [familyB, ownerId]);
  // 加一条成员关系：这样该家庭共 3 行（adopt 用户 + family + member），
  // batchSize=1 时 member 已在独立事务提交，失败后回滚必须靠快照而非事务回滚
  await src.db.query(
    `insert into family_members (id, family_id, user_id, role, joined_at)
     values ($1, $2, $3, 'owner', now())`,
    [newId(), familyB, ownerId],
  );
  const bundleB = path.join(ROOT, 'bundle-b');
  const expB = await exportFamily(src.db, {
    bundleDir: bundleB,
    familyId: familyB,
    sourceInstanceId: src.instanceId,
    storageRoot: src.storage,
  });
  const { manifest: manifestB } = await loadBundle(bundleB);
  const rawB = await readAllRows(bundleB);
  const migrationB = newMigrationId();
  const preB = await preflight(tgt.db, { bundleDir: bundleB, migrationId: migrationB });
  if (!preB.ok) throw new Error(preB.errors.join('; '));
  const familiesBefore = (await tgt.db.queryOne<{ n: number }>(`select count(*)::int as n from families`))!.n;
  const membersBefore = (await tgt.db.queryOne<{ n: number }>(
    `select count(*)::int as n from family_members`,
  ))!.n;
  // 3 行全部处理后再失败：数据已分 3 个事务提交，只能靠快照补偿回滚
  const rb = await applyBundle(tgt.db, {
    bundleDir: bundleB,
    manifest: manifestB,
    rowsByTable: rawB,
    migrationId: migrationB,
    sourceInstanceId: src.instanceId,
    targetStorageRoot: tgt.storage,
    stateDir: path.join(ROOT, 'state', migrationB),
    conflicts: preB.conflicts,
    failAfter: 3,
    batchSize: 1,
  });
  log(`结果状态=${rb.status}，错误=${rb.error}`);
  const familiesAfter = (await tgt.db.queryOne<{ n: number }>(`select count(*)::int as n from families`))!.n;
  const membersAfter = (await tgt.db.queryOne<{ n: number }>(
    `select count(*)::int as n from family_members`,
  ))!.n;
  log(`家庭表数量：失败前 ${familiesBefore} → 回滚后 ${familiesAfter}（应相等）`);
  log(`成员表数量：失败前 ${membersBefore} → 回滚后 ${membersAfter}（应相等，验证跨批次快照回滚）`);
  if (familiesBefore !== familiesAfter || membersBefore !== membersAfter) {
    throw new Error('自动回滚未能恢复迁移前数据');
  }
  const runB = await tgt.db.queryOne<{ status: string }>(
    `select status from migrator_runs where migration_id = $1`,
    [migrationB],
  );
  log(`迁移运行状态=${runB?.status}（期望 rolled_back）`);

  head('演示全部通过 ✓');
  log(`临时文件保留在：${ROOT}（可自行查看 bundle 与 state）`);

  await src.db.close();
  await tgt.db.close();
}

main().catch((err) => {
  console.error('\x1b[31m[demo 失败]\x1b[0m', err);
  process.exit(1);
});
