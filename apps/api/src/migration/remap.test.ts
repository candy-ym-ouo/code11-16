import { describe, it, expect } from 'vitest';
import { IdRemapper } from './remap';

describe('IdRemapper', () => {
  it('家庭常量映射与存储前缀', () => {
    const r = new IdRemapper('srcfam', 'dstfam');
    expect(r.lookup('family', 'srcfam')).toBe('dstfam');
    expect(r.storagePrefixFrom).toBe('families/srcfam/');
    expect(r.storagePrefixTo).toBe('families/dstfam/');
  });

  it('重写行的外键与存储 key', () => {
    const r = new IdRemapper('srcfam', 'dstfam');
    r.record('items', 'src-item', 'dst-item');
    r.record('users', 'src-user', 'dst-user');
    r.record('media', 'src-media', 'dst-media');
    r.record('people', 'src-person', 'dst-person');

    const out = r.rewriteRow('media', {
      id: 'src-media',
      itemId: 'src-item',
      createdBy: 'src-user',
      storageKey: 'families/srcfam/objects/ab/x.png',
      thumbKey: 'families/srcfam/derived/ab/t.webp',
      sha256: 'ab',
    }) as Record<string, unknown>;

    expect(out.itemId).toBe('dst-item');
    expect(out.createdBy).toBe('dst-user');
    expect(out.storageKey).toBe('families/dstfam/objects/ab/x.png');
    expect(out.thumbKey).toBe('families/dstfam/derived/ab/t.webp');
    // sha256 是内容指纹，不参与 ID 重映射
    expect(out.sha256).toBe('ab');
  });

  it('映射不到的外键置空（历史脏数据不阻断迁移）', () => {
    const r = new IdRemapper('srcfam', 'dstfam');
    const out = r.rewriteRow('notes', {
      itemId: 'missing-item',
      authorId: 'missing-user',
      body: 'x',
    }) as Record<string, unknown>;
    expect(out.itemId).toBeNull();
    expect(out.authorId).toBeNull();
  });

  it('松散引用走全局映射（审计 targetId、版本快照）', () => {
    const r = new IdRemapper('srcfam', 'dstfam');
    r.record('items', 'src-item', 'dst-item');
    expect(r.globalLookup('src-item')).toBe('dst-item');
    expect(r.globalLookup('nonexistent')).toBeNull();

    const rewritten = r.rewriteJson({
      action: 'item.publish',
      nested: { id: 'src-item', file: 'families/srcfam/objects/x' },
      list: ['src-item'],
    }) as Record<string, unknown>;
    expect((rewritten.nested as { id: string }).id).toBe('dst-item');
    expect((rewritten.nested as { file: string }).file).toBe('families/dstfam/objects/x');
    expect(rewritten.list).toEqual(['dst-item']);
  });
});
