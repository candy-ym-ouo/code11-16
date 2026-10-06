import { Prisma } from '@prisma/client';
import type { EntityType } from './types';

/** 迁移实体 -> Prisma 模型名。表名固定 snake_case，可由 DMMF 推导。 */
export const ENTITY_MODEL: Record<EntityType, string> = {
  family: 'Family',
  users: 'User',
  settings: 'Setting',
  members: 'FamilyMember',
  invites: 'Invite',
  items: 'Item',
  media: 'ItemMedia',
  people: 'Person',
  itemPeople: 'ItemPerson',
  notes: 'ItemNote',
  itemShares: 'ItemShare',
  versions: 'ItemVersion',
  shareLinks: 'ShareLink',
  shareLinkItems: 'ShareLinkItem',
  auditLogs: 'AuditLog',
};

interface FieldMeta {
  kind: 'scalar' | 'enum' | 'object' | 'unsupported';
  type: string;
  isJson: boolean;
  isBytes: boolean;
  isList: boolean;
  /** 对象字段（外键关系），import 时不在 create 数据里出现 */
  relation?: boolean;
}

const modelFieldsCache = new Map<string, Map<string, FieldMeta>>();

function modelFields(model: string): Map<string, FieldMeta> {
  const cached = modelFieldsCache.get(model);
  if (cached) return cached;
  const dmmfModel = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!dmmfModel) throw new Error(`DMMF 里找不到模型 ${model}`);
  const map = new Map<string, FieldMeta>();
  for (const f of dmmfModel.fields) {
    map.set(f.name, {
      kind: f.kind as FieldMeta['kind'],
      type: f.type,
      isJson: (f as unknown as { type: string }).type === 'Json',
      isBytes: (f as unknown as { type: string }).type === 'Bytes',
      isList: f.isList,
      relation: f.kind === 'object',
    });
  }
  modelFieldsCache.set(model, map);
  return map;
}

export function fieldsOf(entity: EntityType): Map<string, FieldMeta> {
  return modelFields(ENTITY_MODEL[entity]);
}

/** 取可写入数据库的标量/枚举字段，去掉关系对象（关系通过外键标量字段写入）。 */
export function scalarFieldNames(entity: EntityType): string[] {
  const out: string[] = [];
  for (const [name, meta] of modelFields(ENTITY_MODEL[entity])) {
    if (!meta.relation && !meta.isList) out.push(name);
  }
  return out;
}

export function jsonFieldNames(entity: EntityType): string[] {
  const out: string[] = [];
  for (const [name, meta] of modelFields(ENTITY_MODEL[entity])) {
    if (meta.isJson) out.push(name);
  }
  return out;
}

/** 存储 key 字段：import 时需要把源家庭前缀替换为目标家庭前缀。 */
export const STORAGE_KEY_FIELDS: ReadonlySet<string> = new Set([
  'storageKey',
  'thumbKey',
  'largeKey',
  'transcodeKey',
  'waveformKey',
]);

/** 外键字段 -> 它引用的实体类型。import 时用 idMap 重写，映射不到保持 null。 */
export const FK_FIELDS: Record<string, EntityType | 'userOrMissing'> = {
  familyId: 'family',
  createdBy: 'users',
  userId: 'users',
  actorId: 'users',
  authorId: 'users',
  decidedBy: 'users',
  itemId: 'items',
  personId: 'people',
  avatarMediaId: 'media',
  coverMediaId: 'media',
  shareLinkId: 'shareLinks',
  mergedIntoId: 'people',
};
