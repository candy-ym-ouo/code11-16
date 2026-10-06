/**
 * 被迁移的业务表规格（与 apps/api/prisma/schema.prisma 对应）。
 *
 * 迁移顺序即外键依赖的拓扑序；回滚时按 REVERSE 顺序执行。
 * 不迁移的表（实例私有 / 瞬态）：jobs、refresh_tokens、_prisma_migrations
 * 以及 migrator_* 自身的基础设施表。
 */

export type ColumnKind =
  | 'text' // 普通列，原样搬运
  | 'id' // 本表主键，需重映射
  | 'fk' // 外键列，引用 refTable
  | 'fkSoft' // 无数据库约束的软引用（如 items.cover_media_id），按 refTable 重映射
  | 'fkPoly' // 多态引用（audit_logs.target_id），按本行 target_type 决定映射
  | 'json'; // jsonb 列，内部可能嵌有 id 与媒体 key，需深遍历

export interface ColumnSpec {
  name: string;
  kind: ColumnKind;
  /** kind = fk / fkSoft 时引用的表 */
  refTable?: string;
  /** 多态列：target_type 值 -> 引用表；未列出的类型原样保留 */
  polyMap?: Record<string, string>;
}

export interface TableSpec {
  /** 数据库表名 */
  table: string;
  /** Prisma 模型名（多态映射里 audit_logs.target_type 使用模型名） */
  model: string;
  /** 主键列（share_link_items / settings 为复合主键） */
  pk: string[];
  columns: ColumnSpec[];
  /**
   * 幂等重放时用于检测“目标端天然冲突”的业务唯一键。
   * null 表示没有天然键，只按重映射后的主键判定。
   */
  naturalKey: string[] | null;
  /**
   * 导出时如何圈定本表属于该家庭的行。
   * 有 family_id 的表直接过滤；share_link_items 经由 share_links 关联。
   * users 单独按引用集收集（scope='users' 时该字段忽略）。
   */
  scope: 'family' | 'users';
  scopeWhere?: string;
}

export const TABLES: TableSpec[] = [
  {
    table: 'users',
    model: 'User',
    pk: ['id'],
    scope: 'users',
    naturalKey: ['email'],
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'email', kind: 'text' },
      { name: 'password_hash', kind: 'text' },
      { name: 'display_name', kind: 'text' },
      { name: 'avatar_color', kind: 'text' },
      { name: 'system_role', kind: 'text' },
      { name: 'status', kind: 'text' },
      { name: 'created_at', kind: 'text' },
      { name: 'updated_at', kind: 'text' },
    ],
  },
  {
    table: 'families',
    model: 'Family',
    pk: ['id'],
    scope: 'family',
    scopeWhere: 't.id = $1',
    naturalKey: null, // 家庭没有业务唯一键，按重映射主键去重
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'name', kind: 'text' },
      { name: 'description', kind: 'text' },
      { name: 'default_visibility', kind: 'text' },
      { name: 'allow_viewer_comment', kind: 'text' },
      { name: 'created_by', kind: 'fk', refTable: 'users' },
      { name: 'created_at', kind: 'text' },
      { name: 'updated_at', kind: 'text' },
      { name: 'deleted_at', kind: 'text' },
    ],
  },
  {
    table: 'family_members',
    model: 'FamilyMember',
    pk: ['id'],
    scope: 'family',
    naturalKey: ['family_id', 'user_id'],
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'family_id', kind: 'fk', refTable: 'families' },
      { name: 'user_id', kind: 'fk', refTable: 'users' },
      { name: 'role', kind: 'text' },
      { name: 'status', kind: 'text' },
      { name: 'joined_at', kind: 'text' },
    ],
  },
  {
    table: 'invites',
    model: 'Invite',
    pk: ['id'],
    scope: 'family',
    naturalKey: ['code_hash'],
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'family_id', kind: 'fk', refTable: 'families' },
      { name: 'code_hash', kind: 'text' },
      { name: 'role', kind: 'text' },
      { name: 'note', kind: 'text' },
      { name: 'expires_at', kind: 'text' },
      { name: 'max_uses', kind: 'text' },
      { name: 'used_count', kind: 'text' },
      { name: 'created_by', kind: 'fk', refTable: 'users' },
      { name: 'created_at', kind: 'text' },
      { name: 'revoked_at', kind: 'text' },
    ],
  },
  {
    table: 'people',
    model: 'Person',
    pk: ['id'],
    scope: 'family',
    naturalKey: null,
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'family_id', kind: 'fk', refTable: 'families' },
      { name: 'name', kind: 'text' },
      { name: 'relation', kind: 'text' },
      { name: 'birth_year', kind: 'text' },
      { name: 'death_year', kind: 'text' },
      { name: 'bio', kind: 'text' },
      { name: 'avatar_media_id', kind: 'fkSoft', refTable: 'item_media' },
      { name: 'merged_into_id', kind: 'fkSoft', refTable: 'people' }, // 自引用
      { name: 'created_by', kind: 'fk', refTable: 'users' },
      { name: 'created_at', kind: 'text' },
      { name: 'updated_at', kind: 'text' },
      { name: 'deleted_at', kind: 'text' },
    ],
  },
  {
    table: 'items',
    model: 'Item',
    pk: ['id'],
    scope: 'family',
    naturalKey: null,
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'family_id', kind: 'fk', refTable: 'families' },
      { name: 'title', kind: 'text' },
      { name: 'category', kind: 'text' },
      { name: 'status', kind: 'text' },
      { name: 'visibility', kind: 'text' },
      { name: 'acquired_at', kind: 'text' },
      { name: 'acquired_precision', kind: 'text' },
      { name: 'acquired_label', kind: 'text' },
      { name: 'acquired_note', kind: 'text' },
      { name: 'place_text', kind: 'text' },
      { name: 'place_city', kind: 'text' },
      { name: 'place_province', kind: 'text' },
      { name: 'place_country', kind: 'text' },
      { name: 'place_lat', kind: 'text' },
      { name: 'place_lng', kind: 'text' },
      { name: 'story_html', kind: 'text' },
      { name: 'story_text', kind: 'text' },
      { name: 'condition', kind: 'text' },
      { name: 'storage_location', kind: 'text' },
      { name: 'tags', kind: 'text' }, // text[]，JSON 往返保留数组
      { name: 'cover_media_id', kind: 'fkSoft', refTable: 'item_media' },
      { name: 'sort_at', kind: 'text' },
      { name: 'created_by', kind: 'fk', refTable: 'users' },
      { name: 'created_at', kind: 'text' },
      { name: 'updated_at', kind: 'text' },
      { name: 'deleted_at', kind: 'text' },
    ],
  },
  {
    table: 'item_people',
    model: 'ItemPerson',
    pk: ['id'],
    scope: 'family',
    scopeWhere: 'exists (select 1 from items i where i.id = t.item_id and i.family_id = $1)',
    naturalKey: ['item_id', 'person_id', 'role'],
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'item_id', kind: 'fk', refTable: 'items' },
      { name: 'person_id', kind: 'fk', refTable: 'people' },
      { name: 'role', kind: 'text' },
    ],
  },
  {
    table: 'item_media',
    model: 'ItemMedia',
    pk: ['id'],
    scope: 'family',
    scopeWhere: 'exists (select 1 from items i where i.id = t.item_id and i.family_id = $1)',
    naturalKey: null, // sha256 只是普通索引（非唯一），按主键判定
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'item_id', kind: 'fk', refTable: 'items' },
      { name: 'kind', kind: 'text' },
      { name: 'status', kind: 'text' },
      { name: 'storage_key', kind: 'text' }, // 媒体路径，家庭前缀需改写
      { name: 'sha256', kind: 'text' },
      { name: 'mime_type', kind: 'text' },
      { name: 'byte_size', kind: 'text' },
      { name: 'width', kind: 'text' },
      { name: 'height', kind: 'text' },
      { name: 'duration_ms', kind: 'text' },
      { name: 'thumb_key', kind: 'text' },
      { name: 'large_key', kind: 'text' },
      { name: 'transcode_key', kind: 'text' },
      { name: 'waveform_key', kind: 'text' },
      { name: 'original_name', kind: 'text' },
      { name: 'caption', kind: 'text' },
      { name: 'transcript', kind: 'text' },
      { name: 'sort_order', kind: 'text' },
      { name: 'last_error', kind: 'text' },
      { name: 'created_by', kind: 'fk', refTable: 'users' },
      { name: 'created_at', kind: 'text' },
      { name: 'deleted_at', kind: 'text' },
    ],
  },
  {
    table: 'item_notes',
    model: 'ItemNote',
    pk: ['id'],
    scope: 'family',
    scopeWhere: 'exists (select 1 from items i where i.id = t.item_id and i.family_id = $1)',
    naturalKey: null,
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'item_id', kind: 'fk', refTable: 'items' },
      { name: 'author_id', kind: 'fk', refTable: 'users' },
      { name: 'type', kind: 'text' },
      { name: 'body', kind: 'text' },
      { name: 'status', kind: 'text' },
      { name: 'reject_reason', kind: 'text' },
      { name: 'decided_by', kind: 'fkSoft', refTable: 'users' },
      { name: 'decided_at', kind: 'text' },
      { name: 'created_at', kind: 'text' },
    ],
  },
  {
    table: 'item_shares',
    model: 'ItemShare',
    pk: ['id'],
    scope: 'family',
    scopeWhere: 'exists (select 1 from items i where i.id = t.item_id and i.family_id = $1)',
    naturalKey: ['item_id', 'user_id'],
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'item_id', kind: 'fk', refTable: 'items' },
      { name: 'user_id', kind: 'fk', refTable: 'users' },
      { name: 'can_edit', kind: 'text' },
      { name: 'created_at', kind: 'text' },
    ],
  },
  {
    table: 'item_versions',
    model: 'ItemVersion',
    pk: ['id'],
    scope: 'family',
    scopeWhere: 'exists (select 1 from items i where i.id = t.item_id and i.family_id = $1)',
    naturalKey: ['item_id', 'version'],
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'item_id', kind: 'fk', refTable: 'items' },
      { name: 'version', kind: 'text' },
      { name: 'snapshot', kind: 'json' },
      { name: 'created_by', kind: 'fk', refTable: 'users' },
      { name: 'created_at', kind: 'text' },
    ],
  },
  {
    table: 'share_links',
    model: 'ShareLink',
    pk: ['id'],
    scope: 'family',
    naturalKey: ['token_hash'],
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'family_id', kind: 'fk', refTable: 'families' },
      { name: 'token_hash', kind: 'text' },
      { name: 'password_hash', kind: 'text' },
      { name: 'label', kind: 'text' },
      { name: 'expires_at', kind: 'text' },
      { name: 'revoked_at', kind: 'text' },
      { name: 'access_count', kind: 'text' },
      { name: 'last_access_at', kind: 'text' },
      { name: 'created_by', kind: 'fk', refTable: 'users' },
      { name: 'created_at', kind: 'text' },
    ],
  },
  {
    table: 'share_link_items',
    model: 'ShareLinkItem',
    pk: ['share_link_id', 'item_id'],
    scope: 'family',
    scopeWhere:
      'exists (select 1 from share_links sl where sl.id = t.share_link_id and sl.family_id = $1)',
    naturalKey: null,
    columns: [
      { name: 'share_link_id', kind: 'fk', refTable: 'share_links' },
      { name: 'item_id', kind: 'fk', refTable: 'items' },
    ],
  },
  {
    table: 'audit_logs',
    model: 'AuditLog',
    pk: ['id'],
    scope: 'family',
    naturalKey: null,
    columns: [
      { name: 'id', kind: 'id' },
      { name: 'family_id', kind: 'fk', refTable: 'families' },
      { name: 'actor_id', kind: 'fk', refTable: 'users' },
      { name: 'action', kind: 'text' },
      { name: 'target_type', kind: 'text' },
      {
        name: 'target_id',
        kind: 'fkPoly',
        polyMap: {
          Family: 'families',
          FamilyMember: 'family_members',
          Invite: 'invites',
          Person: 'people',
          Item: 'items',
          ItemMedia: 'item_media',
          ItemNote: 'item_notes',
          ItemVersion: 'item_versions',
          ShareLink: 'share_links',
          Setting: 'settings',
          // User 是全局实体，不属于家庭导出范围，这里不映射
        },
      },
      { name: 'diff', kind: 'json' },
      { name: 'ip', kind: 'text' },
      { name: 'user_agent', kind: 'text' },
      { name: 'created_at', kind: 'text' },
    ],
  },
  {
    table: 'settings',
    model: 'Setting',
    pk: ['family_id', 'key'],
    scope: 'family',
    naturalKey: null,
    columns: [
      { name: 'family_id', kind: 'fk', refTable: 'families' },
      { name: 'key', kind: 'text' },
      { name: 'value', kind: 'json' },
      { name: 'updated_at', kind: 'text' },
    ],
  },
];

export const TABLE_BY_NAME = new Map(TABLES.map((t) => [t.table, t]));

/** 回滚顺序：子表先删，父表后删 */
export const REVERSE_TABLES = [...TABLES].reverse();

/** 不迁移的表：作业队列、刷新令牌、Prisma 迁移记录 */
export const EXCLUDED_TABLES = ['jobs', 'refresh_tokens', '_prisma_migrations'];

/** 承载家庭媒体对象的存储 key 列（路径前缀 families/<familyId>/ 需要改写） */
export const MEDIA_KEY_COLUMNS = [
  'storage_key',
  'thumb_key',
  'large_key',
  'transcode_key',
  'waveform_key',
] as const;
