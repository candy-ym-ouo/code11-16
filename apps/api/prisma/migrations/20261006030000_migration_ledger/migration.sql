-- 跨实例迁移：幂等台账 + 批次记录。
-- migration_records 记录源端 ID -> 目标端 ID 的映射，重放时用于跳过已导入行；
-- migration_runs 记录每次导入的快照位置与状态，供失败回滚到迁移前快照。

CREATE TABLE "migration_records" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migration_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "migration_records_bundle_id_entity_type_source_id_key"
    ON "migration_records"("bundle_id", "entity_type", "source_id");

CREATE INDEX "migration_records_bundle_id_entity_type_idx"
    ON "migration_records"("bundle_id", "entity_type");

CREATE TABLE "migration_runs" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "source_family" TEXT NOT NULL,
    "target_family" TEXT,
    "status" TEXT NOT NULL,
    "stats" JSONB,
    "problems" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "snapshot_dir" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "migration_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "migration_runs_bundle_id_idx" ON "migration_runs"("bundle_id");
