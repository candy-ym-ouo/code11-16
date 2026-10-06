import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  fingerprintRow,
  mapStringsDeep,
  newId,
  normalizeTimestamp,
  remapId,
  roundTrip,
  sha256Hex,
} from './ids.js';
import { buildGlobalIdMap, buildIdMaps, rewriteMediaKey, transformRow } from './remap.js';
import { TABLE_BY_NAME } from './schema.js';
import type { Row } from './db.js';

describe('ids', () => {
  it('newId 是 cuid 风格 24 位字符串', () => {
    const id = newId();
    expect(id).toMatch(/^c[a-z0-9]{23}$/);
    expect(newId()).not.toBe(id);
  });

  it('remapId 对相同输入确定、对不同输入分散', () => {
    const a1 = remapId('mig_1', 'items', 'abc');
    const a2 = remapId('mig_1', 'items', 'abc');
    const b = remapId('mig_1', 'items', 'abd');
    const c = remapId('mig_2', 'items', 'abc');
    expect(a1).toBe(a2);
    expect(a1).toMatch(/^m[a-z0-9]{23}$/);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(c);
  });

  it('canonicalJson 不受键顺序影响', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('roundTrip 规范化 bigint / Date / undefined', () => {
    expect(roundTrip(BigInt(123))).toBe(123);
    expect(roundTrip(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(roundTrip({ a: undefined })).toEqual({ a: null });
  });

  it('normalizeTimestamp 把不带时区的时间按 UTC 规范化', () => {
    expect(normalizeTimestamp('2026-09-01T08:00:00')).toBe('2026-09-01T08:00:00.000Z');
    expect(normalizeTimestamp('2026-09-01 08:00:00.12')).toBe('2026-09-01T08:00:00.120Z');
    expect(normalizeTimestamp(42)).toBe(42);
  });

  it('fingerprintRow 稳定且区分映射前后', () => {
    const row = { id: 'a', title: '柜子' };
    expect(fingerprintRow(row)).toBe(fingerprintRow({ title: '柜子', id: 'a' }));
    expect(fingerprintRow(row)).not.toBe(fingerprintRow(row, true));
  });

  it('sha256Hex 与已知值一致', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('mapStringsDeep', () => {
  it('深遍历嵌套结构只改写字符串叶子', () => {
    const v = {
      actor: 'user-1',
      nested: [{ target: 'user-2' }, 3, true],
      num: 5,
      text: '普通文本不变',
    };
    const out = mapStringsDeep(v, (s) => (s.startsWith('user-') ? `mapped:${s}` : s));
    expect(out).toEqual({
      actor: 'mapped:user-1',
      nested: [{ target: 'mapped:user-2' }, 3, true],
      num: 5,
      text: '普通文本不变',
    });
  });
});

describe('remap', () => {
  const family = 'fam-source';
  const newFamily = 'fam-target';
  const user = 'usr-source';
  const item = 'item-source';
  const media = 'media-source';
  const rows = new Map<string, Row[]>([
    ['users', [{ id: user }]],
    ['families', [{ id: family, created_by: user }]],
    ['items', [{ id: item, family_id: family, created_by: user, cover_media_id: media }]],
    ['item_media', [{ id: media, item_id: item, storage_key: `families/${family}/objects/aa/x.jpg` }]],
  ]);
  const idMaps = buildIdMaps(rows, 'mig_t');
  idMaps.get('users')!.set(user, 'usr-adopted-target'); // 模拟 adopt
  const global = buildGlobalIdMap(idMaps);

  it('transformRow 重映射外键、软引用与媒体 key 前缀', () => {
    const spec = TABLE_BY_NAME.get('items')!;
    const out = transformRow(
      spec,
      rows.get('items')![0]!,
      idMaps,
      global,
      family,
      newFamily,
    );
    expect(out.id).toBe(remapId('mig_t', 'items', item));
    expect(out.family_id).toBe(remapId('mig_t', 'families', family));
    expect(out.created_by).toBe('usr-adopted-target');
    expect(out.cover_media_id).toBe(remapId('mig_t', 'item_media', media));
  });

  it('媒体行的 storage_key 改写家庭前缀，其他列不动', () => {
    const spec = TABLE_BY_NAME.get('item_media')!;
    const out = transformRow(spec, rows.get('item_media')![0]!, idMaps, global, family, newFamily);
    expect(out.storage_key).toBe(`families/${newFamily}/objects/aa/x.jpg`);
  });

  it('rewriteMediaKey 仅改写属于旧家庭前缀的 key', () => {
    expect(rewriteKey(`families/${family}/derived/aa/y`, family, newFamily)).toBe(
      `families/${newFamily}/derived/aa/y`,
    );
    expect(rewriteKey('families/other/objects/aa/z', family, newFamily)).toBe(
      'families/other/objects/aa/z',
    );
  });

  it('json 列内嵌的旧家庭媒体路径会被深遍历改写', () => {
    const spec = TABLE_BY_NAME.get('settings')!;
    const out = transformRow(
      spec,
      {
        family_id: family,
        key: 'k',
        value: { cover: `families/${family}/objects/aa/x.jpg`, n: 1 },
        updated_at: null,
      },
      idMaps,
      global,
      family,
      newFamily,
    );
    expect((out.value as Row).cover).toBe(`families/${newFamily}/objects/aa/x.jpg`);
  });

  it('audit_logs 多态 target_id 按 target_type 选表映射', () => {
    const spec = TABLE_BY_NAME.get('audit_logs')!;
    const out = transformRow(
      spec,
      {
        id: 'log1',
        family_id: family,
        actor_id: user,
        action: 'x',
        target_type: 'Item',
        target_id: item,
        diff: null,
      },
      idMaps,
      global,
      family,
      newFamily,
    );
    expect(out.target_id).toBe(remapId('mig_t', 'items', item));
  });

  it('未知 target_type 的多态引用原样保留', () => {
    const spec = TABLE_BY_NAME.get('audit_logs')!;
    const out = transformRow(
      spec,
      {
        id: 'log2', family_id: family, actor_id: user, action: 'x',
        target_type: 'SomethingElse', target_id: 'weird-id', diff: null,
      },
      idMaps,
      global,
      family,
      newFamily,
    );
    expect(out.target_id).toBe('weird-id');
  });

  it('悬空软引用保留原值，硬外键悬空抛错', () => {
    const spec = TABLE_BY_NAME.get('people')!;
    const out = transformRow(
      spec,
      {
        id: 'p1', family_id: family, name: 'n', created_by: user,
        merged_into_id: 'ghost-person',
      },
      idMaps,
      global,
      family,
      newFamily,
    );
    expect(out.merged_into_id).toBe('ghost-person');

    expect(() =>
      transformRow(
        spec,
        { id: 'p2', family_id: family, name: 'n', created_by: 'missing-user' },
        idMaps,
        global,
        family,
        newFamily,
      ),
    ).toThrow(/无法重映射/);
  });
});

function rewriteKey(k: string, a: string, b: string) {
  return rewriteMediaKey(k, a, b);
}
