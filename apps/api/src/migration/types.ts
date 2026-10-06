/**
 * 跨实例迁移工具共用类型。
 *
 * 迁移包（bundle）是一个自描述目录：
 *
 *   <bundle>/
 *   ├── manifest.json        # 版本、来源、行数、每个文件的 sha256
 *   ├── tables/<entity>.jsonl
 *   ├── storage/families/<源家庭ID>/...   # 按内容寻址的原始/派生媒体
 *   └── README.txt
 *
 * 目标端不相信文件名和行数，只相信 manifest 里的 sha256。
 */

export const BUNDLE_VERSION = 1;

/** 幂等台账里的实体类型，同时也是 tables/ 下的文件名。 */
export const ENTITIES = [
  'family',
  'users',
  'settings',
  'members',
  'invites',
  'items',
  'media',
  'people',
  'itemPeople',
  'notes',
  'itemShares',
  'versions',
  'shareLinks',
  'shareLinkItems',
  'auditLogs',
] as const;

export type EntityType = (typeof ENTITIES)[number];

export interface StorageFileEntry {
  /** 相对存储根的 POSIX 路径，例如 families/<fid>/objects/ab/<sha>.jpg */
  rel: string;
  sha256: string;
  size: number;
}

export interface BundleManifest {
  app: string;
  bundleVersion: number;
  bundleId: string;
  createdAt: string;
  source: {
    familyId: string;
    familyName: string;
    /** 源端最后应用的迁移名，目标端做兼容性校验 */
    migration: string | null;
    database: string;
  };
  counts: Record<EntityType, number>;
  mediaBytes: number;
  files: Record<string, { sha256: string; bytes: number; rows?: number }>;
  storageFiles: StorageFileEntry[];
}

export interface ImportStats {
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  mergedUsers: { sourceId: string; email: string; targetId: string }[];
  mediaCopied: number;
  mediaVerified: number;
  mediaBytes: number;
}

export interface CheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

export function emptyCounts(): Record<EntityType, number> {
  return Object.fromEntries(ENTITIES.map((e) => [e, 0])) as Record<EntityType, number>;
}
