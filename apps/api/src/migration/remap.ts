import path from 'node:path';
import { ENTITIES, type EntityType } from './types';
import { FK_FIELDS, STORAGE_KEY_FIELDS, jsonFieldNames } from './schemaMeta';

/**
 * 标识重映射：源端所有 cuid 在目标端都可能变化，必须维护一张
 * (实体类型, 源ID) -> 目标ID 的映射表。映射来自两处：
 *   1. 本次运行新插入的行（导入时写入台账）；
 *   2. 之前运行的台账（幂等重放时恢复）。
 *
 * 宽松引用（审计日志 targetId、版本快照 JSON、媒体 storageKey 等）
 * 无法在静态层面声明引用类型，统一走全局 ID 表 + 存储前缀改写。
 */
export class IdRemapper {
  readonly sourceFamilyId: string;
  readonly targetFamilyId: string;
  /** 按实体类型分表的映射，外键重写时用 */
  private readonly typed = new Map<EntityType, Map<string, string>>();
  /** 全局 ID 映射，供审计 targetId / diff 这类无类型信息的引用重写 */
  private readonly global = new Map<string, string>();
  /** 已合并到目标既有用户的源用户邮箱 */
  readonly mergedUsers: { sourceId: string; email: string; targetId: string }[] = [];

  constructor(sourceFamilyId: string, targetFamilyId: string) {
    this.sourceFamilyId = sourceFamilyId;
    this.targetFamilyId = targetFamilyId;
    for (const e of ENTITIES) this.typed.set(e, new Map());
    // family 是常量映射：整个包只迁移一个家庭
    this.record('family', sourceFamilyId, targetFamilyId);
  }

  get storagePrefixFrom(): string {
    return path.posix.join('families', this.sourceFamilyId) + '/';
  }

  get storagePrefixTo(): string {
    return path.posix.join('families', this.targetFamilyId) + '/';
  }

  record(entity: EntityType, sourceId: string, targetId: string): void {
    this.typed.get(entity)!.set(sourceId, targetId);
    this.global.set(sourceId, targetId);
  }

  /** 从历史台账恢复映射（幂等重放） */
  preload(entity: string, sourceId: string, targetId: string): void {
    const bucket = this.typed.get(entity as EntityType);
    if (bucket) bucket.set(sourceId, targetId);
    this.global.set(sourceId, targetId);
  }

  lookup(entity: EntityType, sourceId: string | null | undefined): string | null {
    if (sourceId === null || sourceId === undefined) return null;
    return this.typed.get(entity)!.get(sourceId) ?? null;
  }

  /** 无类型信息的松散引用（审计日志 targetId）用全局表重写。 */
  globalLookup(sourceId: string): string | null {
    return this.global.get(sourceId) ?? null;
  }

  /**
   * 把一行源端数据改写成可在目标端插入的数据。
   * - id 字段交给调用方处理（新插入时删除、去重时替换）；
   * - 声明过的外键按类型映射；找不到映射且非空时置 null（历史脏数据不阻断迁移）；
   * - JSON 字段（versions.snapshot、auditLogs.diff）做全局递归重写；
   * - 存储 key 字段改写家庭前缀。
   */
  rewriteRow(entity: EntityType, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    for (const fk of Object.keys(FK_FIELDS)) {
      if (!(fk in out)) continue;
      const target = FK_FIELDS[fk]!;
      const sourceVal = out[fk];
      if (typeof sourceVal !== 'string') continue;
      const mapped = target === 'userOrMissing' ? null : this.lookup(target, sourceVal);
      out[fk] = mapped; // null 表示目标端没有对应实体
    }

    // 人物合并：mergedIntoId 指向同表另一个人
    if (typeof out.mergedIntoId === 'string') {
      out.mergedIntoId = this.lookup('people', out.mergedIntoId);
    }

    // 媒体自引用（封面/头像）
    for (const selfFk of ['avatarMediaId', 'coverMediaId']) {
      if (typeof out[selfFk] === 'string') {
        out[selfFk] = this.lookup('media', out[selfFk] as string);
      }
    }

    for (const keyField of STORAGE_KEY_FIELDS) {
      const v = out[keyField];
      if (typeof v === 'string' && v.startsWith(this.storagePrefixFrom)) {
        out[keyField] = this.storagePrefixTo + v.slice(this.storagePrefixFrom.length);
      }
    }

    for (const jsonField of jsonFieldNames(entity)) {
      if (out[jsonField] !== undefined && out[jsonField] !== null) {
        out[jsonField] = this.rewriteJson(out[jsonField]);
      }
    }

    return out;
  }

  /** 版本快照 / 审计 diff：里面散落着各种 ID 和 storageKey，做全局递归重写。 */
  rewriteJson(value: unknown): unknown {
    const idMap = this.global;
    const from = this.storagePrefixFrom;
    const to = this.storagePrefixTo;
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const mapped = idMap.get(v);
        if (mapped !== undefined) return mapped;
        if (v.startsWith(from)) return to + v.slice(from.length);
        return v;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const r: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(o)) r[k] = walk(val);
        return r;
      }
      return v;
    };
    return walk(value);
  }
}
