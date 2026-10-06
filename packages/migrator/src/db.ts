/**
 * 数据库适配层：同一套接口支持两种后端
 *  - postgres:// 连接串 → 真实 PostgreSQL（生产跨实例迁移）
 *  - pglite://<目录>    → 内嵌 PGlite（demo / 测试 / 无服务端环境）
 *
 * 值统一走 JSON 往返：查询用 to_jsonb(t)，写入用 jsonb_populate_record，
 * 两种后端的类型表现因此完全一致（Decimal→number/string、数组、jsonb 都自然处理）。
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

export type Row = Record<string, unknown>;

export interface DbTx {
  query<R extends Row = Row>(sql: string, params?: unknown[]): Promise<R[]>;
  queryOne<R extends Row = Row>(sql: string, params?: unknown[]): Promise<R | null>;
}

export interface Db extends DbTx {
  /** DDL / 多语句脚本（无参数），两种后端都走 simple query 通道 */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly backend: 'pglite' | 'pg';
}

export function isPgliteUrl(url: string): boolean {
  return url.startsWith('pglite://');
}

/** 解析 pglite://<绝对或相对目录>，pglite://memory 表示内存库 */
export function pgliteDataDir(url: string): string {
  const dir = url.slice('pglite://'.length);
  if (dir === 'memory' || dir === '') return 'memory';
  return path.resolve(dir);
}

export async function connect(url: string): Promise<Db> {
  if (isPgliteUrl(url)) {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = pgliteDataDir(url);
    const conn = new PGlite(dir === 'memory' ? undefined : dir);
    await conn.waitReady;
    return makePglite(conn);
  }
  const pg = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  pool.on('error', (err) => {
    // 空闲连接错误不应炸掉进程
    console.error('[db] 空闲连接错误:', err.message);
  });
  return makePg(pool);
}

// ---------------- PGlite ----------------

function makePglite(conn: import('@electric-sql/pglite').PGlite): Db {
  const txLike = (c: {
    query<R extends Row>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  }): DbTx => ({
    async query<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<R[]> {
      const res = await c.query<R>(sql, params as never[]);
      return res.rows;
    },
    async queryOne<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<R | null> {
      const res = await c.query<R>(sql, params as never[]);
      return (res.rows[0] as R | undefined) ?? null;
    },
  });

  const base = txLike(conn);
  return {
    backend: 'pglite',
    ...base,
    async exec(sql: string): Promise<void> {
      await conn.exec(sql);
    },
    async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      // PGlite 单连接：BEGIN/COMMIT 走同一连接即可
      await conn.exec('BEGIN');
      try {
        const result = await fn(txLike(conn));
        await conn.exec('COMMIT');
        return result;
      } catch (err) {
        await conn.exec('ROLLBACK');
        throw err;
      }
    },
    async close(): Promise<void> {
      await conn.close();
    },
  };
}

// ---------------- pg (真实 PostgreSQL) ----------------

function makePg(pool: import('pg').Pool): Db {
  const txLike = (c: import('pg').PoolClient | import('pg').Pool): DbTx => ({
    async query<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<R[]> {
      const res = await c.query<R>(sql, params as never[]);
      return res.rows;
    },
    async queryOne<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<R | null> {
      const res = await c.query<R>(sql, params as never[]);
      return (res.rows[0] as R | undefined) ?? null;
    },
  });

  return {
    backend: 'pg',
    ...txLike(pool),
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(txLike(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

// ---------------- 模式初始化 ----------------

/** 定位 Prisma init 迁移 SQL（apps/api/prisma/migrations/*_init/migration.sql） */
export function defaultInitSqlPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/ 或 src/ 下都回溯到仓库根
  return path.resolve(
    here,
    '..',
    '..',
    '..',
    'apps',
    'api',
    'prisma',
    'migrations',
    '20261004085533_init',
    'migration.sql',
  );
}

/**
 * 迁移工具自己的基础设施表（幂等创建，不属于业务导出范围）：
 *  - migrator_instances  本实例 ID（导出/导入双向校验，防止回灌自己）
 *  - migrator_id_map     源标识 -> 目标标识（确定性重映射 + 幂等重放依据）
 *  - migrator_runs       每次迁移运行的状态
 *  - migrator_snapshots  迁移前目标行快照（逻辑回滚依据）
 *  - migrator_media_snapshots 媒体文件快照（回滚时恢复/删除对象存储文件）
 */
export const MIGRATOR_DDL = `
CREATE TABLE IF NOT EXISTS migrator_instances (
    instance_id TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS migrator_id_map (
    migration_id   TEXT NOT NULL,
    table_name     TEXT NOT NULL,
    source_id      TEXT NOT NULL,
    target_id      TEXT NOT NULL,
    action         TEXT NOT NULL, -- inserted | adopted | skipped
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (migration_id, table_name, source_id)
);
CREATE INDEX IF NOT EXISTS migrator_id_map_target_idx
    ON migrator_id_map (migration_id, table_name, target_id);

CREATE TABLE IF NOT EXISTS migrator_runs (
    migration_id   TEXT PRIMARY KEY,
    source_instance_id TEXT NOT NULL,
    source_family_id   TEXT NOT NULL,
    bundle_fingerprint TEXT NOT NULL,
    status         TEXT NOT NULL, -- running | done | failed | rolled_back
    error          TEXT,
    stats          JSONB NOT NULL DEFAULT '{}',
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    rolled_back_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS migrator_snapshots (
    id             BIGSERIAL PRIMARY KEY,
    migration_id   TEXT NOT NULL,
    table_name     TEXT NOT NULL,
    target_pk      JSONB NOT NULL,  -- 重映射后的主键值（可能是复合主键）
    action         TEXT NOT NULL,   -- inserted | updated
    old_row        JSONB,           -- updated 时保存的迁移前整行；inserted 为 null
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS migrator_snapshots_run_idx
    ON migrator_snapshots (migration_id, table_name);

CREATE TABLE IF NOT EXISTS migrator_media_snapshots (
    id             BIGSERIAL PRIMARY KEY,
    migration_id   TEXT NOT NULL,
    target_key     TEXT NOT NULL,
    action         TEXT NOT NULL,   -- copied（新写入）| overwritten（覆盖已有）
    old_blob_path  TEXT,            -- overwritten 时旧文件备份在状态目录里的相对路径
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS migrator_media_snapshots_run_idx
    ON migrator_media_snapshots (migration_id);
`;

export async function initSchema(db: Db, initSqlPath?: string): Promise<void> {
  const sqlPath = initSqlPath ?? defaultInitSqlPath();
  const ddl = await fs.readFile(sqlPath, 'utf8');
  await db.exec(ddl);
  await db.exec(MIGRATOR_DDL);
}

/** 只安装 migrator_* 基础设施表（目标端已是线上库、业务表已存在时使用） */
export async function ensureMigratorTables(db: Db): Promise<void> {
  await db.exec(MIGRATOR_DDL);
}
