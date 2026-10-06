/**
 * 跨实例迁移的源端造数脚本：在当前 DATABASE_URL 指向的库里建一个
 * 覆盖全部实体类型的家庭（用户/成员/邀请/条目/人物/媒体/备注/版本/
 * 分享/审计/设置/软删除），媒体文件直接写入 STORAGE_ROOT。
 *
 * 用法：DATABASE_URL=... STORAGE_ROOT=... tsx scripts/seed-migration-source.ts
 * 输出最后一行是 JSON：{ familyId, ownerEmail }
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  for (let i = 0; i < salt.length; i += 1) salt[i] = i;
  return argon2id({ password, salt, parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'encoded' });
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function main(): Promise<void> {
  const storageRoot = process.env.STORAGE_ROOT
    ? path.resolve(process.env.STORAGE_ROOT)
    : path.resolve(__dirname, '../../../data/uploads-test-source');
  fs.mkdirSync(storageRoot, { recursive: true });

  // 清理同一标记邮箱的旧数据（幂等造数）
  const emails = ['src-owner@example.test', 'src-editor@example.test', 'src-viewer@example.test'];
  for (const email of emails) {
    const u = await db.user.findUnique({ where: { email } });
    if (u) {
      const memberships = await db.familyMember.findMany({ where: { userId: u.id }, select: { familyId: true } });
      for (const m of memberships) {
        await db.family.deleteMany({ where: { id: m.familyId, name: '迁移测试家庭' } });
      }
      await db.user.deleteMany({ where: { id: u.id } });
    }
  }

  const passwordHash = await hashPassword('src-pass-123');
  const owner = await db.user.create({
    data: { email: emails[0]!, passwordHash, displayName: '源端家长', avatarColor: '#8A2BE2', systemRole: 'sysadmin' },
  });
  const editor = await db.user.create({
    data: { email: emails[1]!, passwordHash, displayName: '源端编辑' },
  });
  const viewer = await db.user.create({
    data: { email: emails[2]!, passwordHash, displayName: '源端只读' },
  });

  const family = await db.family.create({
    data: {
      name: '迁移测试家庭',
      description: '跨实例迁移造数',
      defaultVisibility: 'family',
      allowViewerComment: true,
      createdBy: owner.id,
    },
  });

  await db.familyMember.createMany({
    data: [
      { familyId: family.id, userId: owner.id, role: 'owner' },
      { familyId: family.id, userId: editor.id, role: 'editor' },
      { familyId: family.id, userId: viewer.id, role: 'viewer' },
    ],
  });

  await db.setting.create({
    data: { familyId: family.id, key: 'migration.note', value: { hello: '家庭设置值', n: 42 } as never },
  });

  // 制造一个媒体文件（1x1 png）并按内容寻址落盘
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
    'hex',
  );
  const sha = sha256Hex(png);
  const storageKey = `families/${family.id}/objects/${sha.slice(0, 2)}/${sha}.png`;
  const abs = path.join(storageRoot, storageKey);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, png);
  // 派生缩略图（内容不同，另一个 key）
  const thumb = Buffer.concat([png, Buffer.from('thumb')]);
  const thumbSha = sha256Hex(thumb);
  const thumbKey = `families/${family.id}/derived/${thumbSha.slice(0, 2)}/${thumbSha}.webp`;
  fs.mkdirSync(path.join(storageRoot, path.dirname(thumbKey)), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, thumbKey), thumb);

  const grandad = await db.person.create({
    data: { familyId: family.id, name: '外公', relation: '外祖父', birthYear: 1928, deathYear: 2010, bio: '源端人物小传', createdBy: owner.id },
  });
  const duplicate = await db.person.create({
    data: { familyId: family.id, name: '外公（重复）', createdBy: editor.id, mergedIntoId: grandad.id },
  });

  const item1 = await db.item.create({
    data: {
      familyId: family.id,
      title: '樟木箱',
      category: 'furniture',
      status: 'published',
      visibility: 'family',
      acquiredAt: new Date('1978-06-01T00:00:00Z'),
      acquiredPrecision: 'year',
      acquiredLabel: '大概一九七八年',
      placeText: '老屋阁楼',
      placeProvince: '浙江省',
      tags: ['家具', '陪嫁'],
      storyHtml: '<p>这是<strong>外公</strong>打的樟木箱。</p>',
      storyText: '这是外公打的樟木箱。',
      sortAt: new Date('1978-01-01T00:00:00Z'),
      createdBy: owner.id,
    },
  });
  await db.item.update({ where: { id: item1.id }, data: { coverMediaId: null } });

  const media = await db.itemMedia.create({
    data: {
      itemId: item1.id,
      kind: 'image',
      status: 'ready',
      storageKey,
      sha256: sha,
      mimeType: 'image/png',
      byteSize: BigInt(png.length),
      width: 1,
      height: 1,
      thumbKey,
      originalName: '樟木箱.png',
      caption: '源端图片说明',
      sortOrder: 0,
      createdBy: owner.id,
    },
  });
  await db.item.update({ where: { id: item1.id }, data: { coverMediaId: media.id } });
  await db.person.update({ where: { id: grandad.id }, data: { avatarMediaId: media.id } });

  await db.itemPerson.createMany({
    data: [
      { itemId: item1.id, personId: grandad.id, role: 'gifted' },
      { itemId: item1.id, personId: duplicate.id, role: 'mentioned' },
    ],
  });

  await db.itemNote.create({
    data: { itemId: item1.id, authorId: editor.id, type: 'story', body: '我补充一句：箱子里原来有绸缎。', status: 'accepted', decidedBy: owner.id, decidedAt: new Date() },
  });
  await db.itemNote.create({
    data: { itemId: item1.id, authorId: viewer.id, type: 'comment', body: '我记得钥匙在抽屉里。', status: 'pending' },
  });
  await db.itemShare.create({ data: { itemId: item1.id, userId: viewer.id, canEdit: false } });

  await db.itemVersion.create({
    data: {
      itemId: item1.id,
      version: 1,
      snapshot: { title: '樟木箱', createdBy: owner.id, coverMediaId: null } as never,
      createdBy: owner.id,
    },
  });

  const item2 = await db.item.create({
    data: {
      familyId: family.id,
      title: '旧粮票（草稿）',
      category: 'receipt',
      status: 'draft',
      visibility: 'private',
      acquiredPrecision: 'unknown',
      sortAt: new Date('1985-01-01T00:00:00Z'),
      createdBy: editor.id,
    },
  });

  const trashed = await db.item.create({
    data: {
      familyId: family.id,
      title: '已删除条目',
      category: 'other',
      status: 'trashed',
      visibility: 'family',
      acquiredPrecision: 'unknown',
      sortAt: new Date('2000-01-01T00:00:00Z'),
      createdBy: editor.id,
      deletedAt: new Date(),
    },
  });

  // 分享链接（token 已哈希，导入后原链接应继续可用）
  const tokenHash = createHash('sha256').update('src-share-token').digest('hex');
  const share = await db.shareLink.create({
    data: {
      familyId: family.id,
      tokenHash,
      label: '源端对外链接',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      createdBy: owner.id,
      accessCount: 7,
    },
  });
  await db.shareLinkItem.create({ data: { shareLinkId: share.id, itemId: item1.id } });

  // 过期邀请（hash 字段原样迁移）
  await db.invite.create({
    data: {
      familyId: family.id,
      codeHash: createHash('sha256').update('src-invite-code').digest('hex'),
      role: 'viewer',
      expiresAt: new Date(Date.now() - 86400_000),
      createdBy: owner.id,
      maxUses: 1,
    },
  });

  await db.auditLog.createMany({
    data: [
      { familyId: family.id, actorId: owner.id, action: 'family.create', targetType: 'family', targetId: family.id, ip: '127.0.0.1' },
      { familyId: family.id, actorId: owner.id, action: 'item.publish', targetType: 'item', targetId: item1.id },
      { familyId: family.id, actorId: editor.id, action: 'note.create', targetType: 'item_note', targetId: null },
    ],
  });

  // 目标家庭外的干扰数据：另一个家庭（不应被导出）
  const stranger = await db.user.findUnique({ where: { email: 'src-owner@example.test' } });
  void stranger;
  const other = await db.user.findFirst({ where: { email: { not: { in: emails } } } });
  if (other) {
    const otherFamily = await db.family.findFirst({ where: { name: '不应被迁走的家庭' } });
    if (!otherFamily) {
      await db.family.create({ data: { name: '不应被迁走的家庭', createdBy: other.id } });
    }
  }

  console.log(
    JSON.stringify({
      familyId: family.id,
      ownerEmail: emails[0],
      itemIds: [item1.id, item2.id, trashed.id],
      mediaStorageKey: storageKey,
      thumbKey,
      storageRoot,
    }),
  );
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
