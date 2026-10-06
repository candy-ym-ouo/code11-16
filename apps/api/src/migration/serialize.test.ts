import { describe, it, expect } from 'vitest';
import { toJsonlLine, fromJsonlLine, rewriteValue } from './serialize';
import { Prisma } from '@prisma/client';

describe('jsonl 序列化往返', () => {
  it('Date / BigInt / Decimal 都能还原', () => {
    const date = new Date('1978-06-01T00:00:00.000Z');
    const decimal = new Prisma.Decimal('31.123456');
    const row = {
      id: 'c1',
      byteSize: BigInt(1234567890123),
      acquiredAt: date,
      placeLat: decimal,
      tags: ['家具', '陪嫁'],
      nullable: null,
    };
    const restored = fromJsonlLine(toJsonlLine(row));
    expect(restored.id).toBe('c1');
    expect(typeof restored.byteSize).toBe('bigint');
    expect(restored.byteSize).toBe(BigInt(1234567890123));
    expect(restored.acquiredAt).toBeInstanceOf(Date);
    expect((restored.acquiredAt as Date).toISOString()).toBe(date.toISOString());
    expect(restored.placeLat).toBe('31.123456');
    expect(restored.tags).toEqual(['家具', '陪嫁']);
    expect(restored.nullable).toBeNull();
  });

  it('一行只输出一次换行兼容 JSONL', () => {
    expect(toJsonlLine({ a: 1 })).not.toContain('\n');
  });
});

describe('rewriteValue 递归重写', () => {
  const idMap = new Map([
    ['old-item', 'new-item'],
    ['old-user', 'new-user'],
  ]);
  const prefixes = { from: 'families/srcfam/', to: 'families/dstfam/' };

  it('重写嵌套 JSON 里的 ID 与存储前缀', () => {
    const input = {
      title: '樟木箱',
      createdBy: 'old-user',
      coverMediaId: null,
      refs: ['old-item', { actor: 'old-user' }],
      storage: 'families/srcfam/objects/ab/x.png',
      untouched: 'plain',
    };
    const out = rewriteValue(input, idMap, prefixes) as Record<string, unknown>;
    expect(out.createdBy).toBe('new-user');
    expect((out.refs as unknown[])[0]).toBe('new-item');
    expect(((out.refs as unknown[])[1] as { actor: string }).actor).toBe('new-user');
    expect(out.storage).toBe('families/dstfam/objects/ab/x.png');
    expect(out.untouched).toBe('plain');
    expect(out.coverMediaId).toBeNull();
  });

  it('没有前缀映射时只改 ID', () => {
    const out = rewriteValue({ k: 'families/srcfam/x' }, idMap, null) as Record<string, unknown>;
    expect(out.k).toBe('families/srcfam/x');
  });
});
