# @heirloom/migrator · 跨实例家庭数据迁移工具

为「家中物品来历册」提供**单家庭粒度**的跨实例迁移：从一个实例全量导出一个家庭
（数据 + 媒体文件），校验目标实例后，把标识确定性重映射再写入，全过程**幂等可重放、
可断点续跑，失败可回滚到迁移前快照**。

## 能力一览

| 需求 | 实现 |
| --- | --- |
| 家庭数据全量导出 | 15 张业务表按外键拓扑序圈定；用户按引用闭包收集；媒体对象（本体 + 缩略图/转码/波形）内容寻址打包；逐文件 sha256 + 清单指纹 |
| 目标端校验 | 包完整性/防篡改、业务表与基础设施表齐备、schema 版本、**禁止回灌源实例自身**、天然键冲突明细（邮箱采用 / 邀请码·令牌跳过）、重复迁移状态门禁 |
| 标识重映射 | 目标 ID 不复用源 CUID，由 `(migrationId, table, sourceId)` SHA-256 **确定性派生**；外键、软引用、多态引用、JSON 内嵌 ID、媒体路径前缀一并改写 |
| 幂等重放 | 同一 `migrationId` 派生结果稳定；`migrator_id_map` 记录 inserted/adopted/skipped；重放走 upsert 与映射复用，不产生重复数据（需显式 `--force`） |
| 断点续跑 | 按批事务提交（默认 200 行/批）；崩溃后重跑只补未完成批次，已写入行先查快照与映射 |
| 失败回滚 | 数据行前像快照（inserted→删 / updated→还原）+ 媒体旧文件备份（copied→删 / overwritten→还原）；失败默认自动回滚，也可事后 `rollback` |
| 迁移后对账 | verify 用**同一套重映射逻辑**逐行指纹比对、外键完整性检查、媒体文件 sha256 校验 |

不迁移的实例私有数据：`jobs`（后台队列）、`refresh_tokens`（登录令牌）、
`_prisma_migrations`（Prisma 迁移记录）。

## 连接串

| 形式 | 后端 | 用途 |
| --- | --- | --- |
| `postgres://user:pass@host:5432/db` | 真实 PostgreSQL（`pg` 驱动） | 生产跨实例迁移 |
| `pglite:///var/tmp/pgdata` | 内嵌 PGlite（数据持久化到目录） | 演练 / 测试 / 无服务端环境 |
| `pglite://memory` | 内存 PGlite | 临时测试 |

PGlite 与 PostgreSQL 共用同一套 SQL 路径（`to_jsonb` 读取、jsonb 参数写入），
在 PGlite 上演练通过的迁移在真实 PG 上行为一致。

## 命令

```bash
# 在包目录 packages/migrator 下；或 pnpm --filter @heirloom/migrator cli -- <命令> ...

# 0. 初始化目标实例（业务表由 Prisma init migration 创建，migrator_* 表 + 实例 ID 由本工具创建）
heirloom-migrate init --target-url postgres://...

# 1. 源端全量导出
heirloom-migrate export \
  --source-url "$SOURCE_DATABASE_URL" \
  --family-id clxxxxxxxxxxxxxxxxxxxxxxxx \
  --source-storage ./data/uploads \
  --bundle ./data/migrations/bundle-20261006

# 2. 目标端导入前校验（不写任何数据；会给出建议的 migrationId）
heirloom-migrate validate \
  --bundle ./data/migrations/bundle-20261006 \
  --target-url "$TARGET_DATABASE_URL" \
  --migration-id mig_20261006_xxxxxx

# 3. 应用迁移（沿用 validate 给出的 migrationId）
heirloom-migrate apply \
  --bundle ./data/migrations/bundle-20261006 \
  --target-url "$TARGET_DATABASE_URL" \
  --migration-id mig_20261006_xxxxxx \
  --target-storage /data/uploads

# 4. 迁移后对账
heirloom-migrate verify \
  --bundle ./data/migrations/bundle-20261006 \
  --target-url "$TARGET_DATABASE_URL" \
  --migration-id mig_20261006_xxxxxx \
  --target-storage /data/uploads

# 出问题时：回滚到迁移前快照
heirloom-migrate rollback --migration-id mig_20261006_xxxxxx --target-url "$TARGET_DATABASE_URL"

# 查看状态
heirloom-migrate status --target-url "$TARGET_DATABASE_URL"
heirloom-migrate status --migration-id mig_20261006_xxxxxx --target-url "$TARGET_DATABASE_URL"
```

### 关键参数

- `--migration-id`：一次迁移的身份。**validate 给出后，apply/verify/rollback 必须沿用**。
  不传则自动生成 `mig_<时间戳>_<随机>`。
- `--force`：对状态为 `done` 的迁移允许重放（幂等）。
- `--no-auto-rollback`：apply 失败时保留现场（默认自动回滚），修复后重跑同一
  `migrationId` 即断点续跑。
- `--batch-size <N>`：提交粒度（默认 200）。
- `--fail-after <N>`：演练开关，处理满 N 行后注入失败，用于验证回滚/续跑。
- `--state-dir`：迁移状态与被覆盖媒体旧文件的备份目录
  （默认 `data/migrations/state/<migrationId>`），**回滚依赖它，迁移验收前不要删除**。
- `--report <file>`：导出/应用结果落一份机器可读 JSON。

## 导出包格式

```
bundle/
  manifest.json        清单（源实例/家庭、每张表行数与 sha256、媒体清单、总指纹）
  manifest.sig         清单指纹（validate 时重算比对，防篡改/防传输损坏）
  data/<table>.json    15 张表各一个 JSON 数组（to_jsonb 原始行）
  blobs/<sha256>       媒体对象二进制（内容寻址，跨家庭/重复对象自动去重）
```

## 冲突处理策略

目标端可能已有同名业务实体。天然键冲突在 `validate` 阶段全部列出，按表类型决策：

- **users（按 email）→ adopt（采用）**：不新建账号，迁移行中所有对该用户的引用
  （成员关系、`created_by`、作者、审计 actor、JSON 内嵌 ID）统一指向目标端既有账号。
- **invites.code_hash / share_links.token_hash / 各关联表唯一键 → skip（跳过）**：
  冲突行不导入，其**从属闭包级联跳过**（跳过邀请不影响家庭本体；跳过物品则其媒体、
  备注、版本、关联全部不导入），保证不会产生半截引用。
- 无天然键的表（families/items/people/…）：按重映射后的新主键插入，
  因此可以把同一家庭多次迁入同一实例而互不覆盖。

## 安全模型

- 每个数据库在 `migrator_instances` 有随机实例 ID；导出包记录源实例，
  目标端发现与自己相同则拒绝（防止把导出包回灌到源实例造成混乱）。
- 派生 ID 带 `m` 前缀，与业务侧 CUID（`c` 前缀）肉眼可分，且由 migrationId 命名空间隔离，
  两次不同迁移不会碰撞。
- 所有写操作先留前像快照再执行；媒体文件覆盖前复制到 `--state-dir` 留底。
- 大批量操作按批提交并更新 `migrator_runs.stats`，可用 `status` 观察进度。

## 开发与测试

```bash
pnpm --filter @heirloom/migrator test     # 25 个测试：纯函数 + PGlite 端到端
pnpm --filter @heirloom/migrator demo     # 交互式演示全流程（含 adopt、幂等重放、跨批次回滚）
pnpm --filter @heirloom/migrator typecheck
pnpm --filter @heirloom/migrator build
```

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/schema.ts` | 15 张表的列/主键/外键/软引用/多态/JSON 列声明、导出圈定规则、拓扑序 |
| `src/db.ts` | PGlite / `pg` 双后端统一接口、Prisma DDL 初始化、`migrator_*` 基础设施表 |
| `src/ids.ts` | 确定性 ID 派生、规范化（时间戳/bigint/键序）、指纹、JSON 深遍历 |
| `src/bundle.ts` | 导出包格式、读写与完整性校验 |
| `src/export.ts` | 全量导出：范围圈定、引用闭包自检、媒体收集、清单/指纹 |
| `src/preflight.ts` | 导入前校验与天然键冲突检测（内部做重映射，冲突记录保留源 ID） |
| `src/remap.ts` | 纯函数的行转换（apply/verify 共用，保证校验即所写） |
| `src/apply.ts` | 应用迁移：冲突策略、级联跳过、分批事务、快照、媒体复制、回滚 |
| `src/verify.ts` | 迁移后逐行/外键/媒体对账 |
| `src/cli.ts` | 七个子命令的命令行入口 |
