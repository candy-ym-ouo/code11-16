#!/usr/bin/env node
/**
 * heirloom-migrate —— 跨实例家庭数据迁移工具
 *
 * 命令：
 *   init       初始化目标实例（业务表 + migrator_* 基础设施 + 实例 ID）
 *   export     从源实例全量导出一个家庭（数据 + 媒体 + 清单指纹）
 *   validate   对导出包 + 目标实例做导入前校验（冲突、schema、回灌自检）
 *   apply      标识重映射并写入目标实例（幂等可重放、可断点续跑）
 *   verify     迁移后对账（逐行指纹、外键完整性、媒体 sha256）
 *   rollback   按迁移前快照回滚（数据行 + 媒体文件）
 *   status     查看某迁移 / 全部迁移的状态
 *
 * 连接串：
 *   postgres://user:pass@host:5432/db   真实 PostgreSQL
 *   pglite:///tmp/pgdata-dir            内嵌 PGlite（demo / 演练 / 测试）
 *   pglite://memory                     内存 PGlite
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { connect, ensureMigratorTables, initSchema, type Db } from './db.js';
import { exportFamily, type ExportReport } from './export.js';
import { preflight } from './preflight.js';
import { applyBundle, rollback, type ApplyReport } from './apply.js';
import { verifyTarget } from './verify.js';
import { loadBundle, readAllRows } from './bundle.js';
import { newInstanceId, newMigrationId } from './ids.js';

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) {
        flags.set(key.slice(0, eq), key.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
        flags.set(key, argv[i + 1]!);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

function log(msg: string) {
  console.log(`${c.dim(new Date().toLocaleTimeString())} ${msg}`);
}
function ok(msg: string) {
  console.log(`${c.green('✓')} ${msg}`);
}
function warn(msg: string) {
  console.log(`${c.yellow('!')} ${msg}`);
}
function die(msg: string): never {
  console.error(`${c.red('✗')} ${msg}`);
  process.exit(1);
}

function str(flags: Map<string, string | boolean>, key: string, fallback?: string): string {
  const v = flags.get(key);
  if (typeof v === 'string') return v;
  if (v === true) die(`--${key} 需要一个值`);
  if (fallback !== undefined) return fallback;
  die(`缺少参数 --${key}`);
}
function bool(flags: Map<string, string | boolean>, key: string): boolean {
  return flags.get(key) === true || flags.get(key) === 'true';
}

async function getOrInitInstanceId(db: Db): Promise<string> {
  const row = await db.queryOne<{ instance_id: string }>(
    'select instance_id from migrator_instances limit 1',
  );
  if (row) return row.instance_id;
  const id = newInstanceId();
  await db.query('insert into migrator_instances (instance_id) values ($1)', [id]);
  return id;
}

async function jsonOut(value: unknown, file?: string): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (file) {
    await fsp.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await fsp.writeFile(file, text);
  } else {
    console.log(text);
  }
}

function printExport(r: ExportReport) {
  console.log(c.bold(`导出完成：${r.familyName}`));
  for (const [table, n] of Object.entries(r.rowsPerTable)) {
    if (n > 0) console.log(`  ${table.padEnd(18)} ${n} 行`);
  }
  console.log(`  合计 ${r.totalRows} 行 / 媒体 ${r.mediaCount} 个对象（${(r.mediaBytes / 1024).toFixed(1)} KiB）`);
  if (r.mediaMissing.length > 0) warn(`缺失媒体 ${r.mediaMissing.length} 个（已在清单登记）`);
  for (const w of r.warnings) warn(w);
  ok(`导出包：${r.bundleDir}`);
  console.log(`  指纹 ${c.dim(r.fingerprint)}`);
}

function printApply(r: ApplyReport) {
  if (r.status === 'done') ok(c.bold('迁移完成'));
  else if (r.status === 'rolled_back') warn(c.bold('迁移失败并已回滚到迁移前快照'));
  else warn(c.bold('迁移失败（保留现场，可修复后续跑）'));
  for (const [table, s] of Object.entries(r.stats)) {
    if (s.total === 0) continue;
    const tail = [
      s.inserted && `插入 ${s.inserted}`,
      s.adopted && `采用 ${s.adopted}`,
      s.skipped && `跳过 ${s.skipped}`,
    ]
      .filter(Boolean)
      .join(' / ');
    console.log(`  ${table.padEnd(18)} ${s.total} 行 → ${tail}`);
  }
  console.log(`  媒体：写入 ${r.mediaCopied} 个（覆盖既有 ${r.mediaOverwritten} 个，${(r.mediaBytes / 1024).toFixed(1)} KiB）`);
  if (r.error) console.log(c.red(`  错误：${r.error}`));
}

async function cmdInit(args: ParsedArgs): Promise<void> {
  const url = str(args.flags, 'url', process.env.DATABASE_URL ?? 'pglite://memory');
  const initSql = args.flags.get('init-sql');
  const db = await connect(url);
  try {
    log(`初始化实例（${db.backend}）…`);
    await initSchema(db, typeof initSql === 'string' ? initSql : undefined);
    const id = await getOrInitInstanceId(db);
    ok(`业务表与 migrator 基础设施就绪，实例 ID：${c.dim(id)}`);
  } finally {
    await db.close();
  }
}

async function cmdExport(args: ParsedArgs): Promise<void> {
  const url = str(args.flags, 'source-url', process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL);
  const familyId = str(args.flags, 'family-id');
  const bundleDir = path.resolve(str(args.flags, 'bundle', `data/migrations/bundle-${familyId.slice(0, 10)}`));
  const storageRoot = path.resolve(str(args.flags, 'source-storage', process.env.STORAGE_ROOT ?? 'data/uploads'));
  const reportFile = args.flags.get('report');
  const db = await connect(url);
  try {
    await ensureMigratorTables(db);
    const instanceId = await getOrInitInstanceId(db);
    log(`从源实例导出家庭 ${familyId}（实例 ${instanceId.slice(0, 18)}…）`);
    const report = await exportFamily(db, {
      bundleDir,
      familyId,
      sourceInstanceId: instanceId,
      storageRoot,
      strictMedia: bool(args.flags, 'strict-media'),
    });
    printExport(report);
    if (reportFile) await jsonOut(report, String(reportFile));
  } finally {
    await db.close();
  }
}

async function cmdValidate(args: ParsedArgs): Promise<void> {
  const bundleDir = path.resolve(str(args.flags, 'bundle'));
  const url = str(args.flags, 'target-url', process.env.TARGET_DATABASE_URL ?? process.env.DATABASE_URL);
  const migrationId = str(args.flags, 'migration-id', newMigrationId());
  const db = await connect(url);
  try {
    await ensureMigratorTables(db);
    log(`校验导出包与目标实例（预演 migrationId=${migrationId}）…`);
    const result = await preflight(db, { bundleDir, migrationId, allowDone: bool(args.flags, 'force') });
    for (const w of result.warnings) warn(w);
    if (result.conflicts.length > 0) {
      console.log(c.bold('  天然键冲突明细：'));
      for (const cf of result.conflicts) {
        console.log(`    [${cf.policy === 'adopt' ? '采用' : '跳过'}] ${cf.table} 自然键=${JSON.stringify(cf.naturalKey)}`);
      }
    }
    if (!result.ok) {
      for (const e of result.errors) console.log(c.red(`  ✗ ${e}`));
      die(`校验未通过：${result.errors.length} 个阻断项`);
    }
    ok('校验通过，可以 apply');
    console.log(c.dim(`  提示：apply 时请使用同一 migrationId：--migration-id ${migrationId}`));
  } finally {
    await db.close();
  }
}

async function cmdApply(args: ParsedArgs): Promise<void> {
  const bundleDir = path.resolve(str(args.flags, 'bundle'));
  const url = str(args.flags, 'target-url', process.env.TARGET_DATABASE_URL ?? process.env.DATABASE_URL);
  const migrationId = str(args.flags, 'migration-id', newMigrationId());
  const storageRoot = path.resolve(str(args.flags, 'target-storage', process.env.STORAGE_ROOT ?? 'data/uploads'));
  const stateDir = path.resolve(str(args.flags, 'state-dir', `data/migrations/state/${migrationId}`));
  const noAutoRollback = bool(args.flags, 'no-auto-rollback');
  const force = bool(args.flags, 'force');
  const failAfter = args.flags.get('fail-after');
  const reportFile = args.flags.get('report');

  const db = await connect(url);
  try {
    await ensureMigratorTables(db);

    log('导入前校验…');
    const pre = await preflight(db, { bundleDir, migrationId, allowDone: force });
    for (const w of pre.warnings) warn(w);
    if (!pre.ok) {
      for (const e of pre.errors) console.log(c.red(`  ✗ ${e}`));
      die('校验未通过，已中止（目标端未做任何修改）');
    }
    const { manifest, rowsByTable: rawRows } = pre;

    log(`开始迁移（migrationId=${migrationId}，状态目录 ${stateDir}）`);
    const report = await applyBundle(db, {
      bundleDir,
      manifest,
      rowsByTable: rawRows,
      migrationId,
      sourceInstanceId: manifest.source.instanceId,
      targetStorageRoot: storageRoot,
      stateDir,
      conflicts: pre.conflicts,
      autoRollback: !noAutoRollback,
      failAfter: typeof failAfter === 'string' ? Number(failAfter) : undefined,
      batchSize: Number(args.flags.get('batch-size') ?? 200),
      onProgress: (m) => log(m),
    });
    printApply(report);
    if (reportFile) await jsonOut(report, String(reportFile));
    if (report.status === 'rolled_back') process.exitCode = 2;
    else if (report.status === 'failed') process.exitCode = 3;
    else ok(`可用 verify --migration-id ${migrationId} 做迁移后对账`);
  } finally {
    await db.close();
  }
}

async function cmdVerify(args: ParsedArgs): Promise<void> {
  const bundleDir = path.resolve(str(args.flags, 'bundle'));
  const url = str(args.flags, 'target-url', process.env.TARGET_DATABASE_URL ?? process.env.DATABASE_URL);
  const migrationId = str(args.flags, 'migration-id');
  const storageRoot = path.resolve(str(args.flags, 'target-storage', process.env.STORAGE_ROOT ?? 'data/uploads'));
  const db = await connect(url);
  try {
    const { manifest } = await loadBundle(bundleDir);
    const rowsByTable = await readAllRows(bundleDir);
    const result = await verifyTarget(db, { manifest, rowsByTable, migrationId, targetStorageRoot: storageRoot });
    console.log(c.bold('迁移后对账'));
    for (const [t, s] of Object.entries(result.perTable)) {
      if (s.expected === 0) continue;
      console.log(`  ${t.padEnd(18)} 期望 ${s.expected} / 命中 ${s.found}`);
    }
    console.log(`  逐行核对 ${result.checkedRows} 行，媒体对象 ${result.checkedMedia} 个`);
    if (result.ok) ok('对账通过：目标端与导出包完全一致');
    else {
      for (const p of result.problems) console.log(c.red(`  ✗ ${p}`));
      die(`对账失败：${result.problems.length} 处不一致`);
    }
  } finally {
    await db.close();
  }
}

async function cmdRollback(args: ParsedArgs): Promise<void> {
  const migrationId = str(args.flags, 'migration-id');
  const url = str(args.flags, 'target-url', process.env.TARGET_DATABASE_URL ?? process.env.DATABASE_URL);
  const storageRoot = path.resolve(str(args.flags, 'target-storage', process.env.STORAGE_ROOT ?? 'data/uploads'));
  const stateDir = path.resolve(str(args.flags, 'state-dir', `data/migrations/state/${migrationId}`));
  const db = await connect(url);
  try {
    log(`按快照回滚迁移 ${migrationId}…`);
    await rollback(db, { migrationId, targetStorageRoot: storageRoot, stateDir, progress: (m) => log(m) });
    ok('已回滚到迁移前快照');
  } finally {
    await db.close();
  }
}

async function cmdStatus(args: ParsedArgs): Promise<void> {
  const url = str(args.flags, 'target-url', process.env.TARGET_DATABASE_URL ?? process.env.DATABASE_URL);
  const migrationId = args.flags.get('migration-id');
  const db = await connect(url);
  try {
    if (typeof migrationId === 'string') {
      const run = await db.queryOne(
        `select migration_id, source_family_id, status, error, stats, started_at, finished_at, rolled_back_at
         from migrator_runs where migration_id = $1`,
        [migrationId],
      );
      if (!run) die(`找不到迁移：${migrationId}`);
      const maps = await db.query<{ table_name: string; action: string; count: string }>(
        `select table_name, action, count(*)::text as count from migrator_id_map
         where migration_id = $1 group by table_name, action order by table_name, action`,
        [migrationId],
      );
      console.log(JSON.stringify(run, null, 2));
      console.log(c.bold('行映射：'));
      for (const m of maps) console.log(`  ${m.table_name.padEnd(18)} ${m.action.padEnd(9)} ${m.count}`);
    } else {
      const runs = await db.query(
        `select migration_id, source_family_id, status, started_at, finished_at
         from migrator_runs order by started_at desc limit 20`,
      );
      if (runs.length === 0) {
        warn('目标实例还没有任何迁移记录');
        return;
      }
      for (const r of runs) {
        const mark = r.status === 'done' ? c.green('done') : r.status === 'rolled_back' ? c.yellow('rolled_back') : c.red(String(r.status));
        console.log(`  ${String(r.migration_id).padEnd(34)} ${mark.padEnd(12)} family=${String(r.source_family_id).slice(0, 12)}…`);
      }
    }
  } finally {
    await db.close();
  }
}

const HELP = `
${c.bold('heirloom-migrate')} —— 跨实例家庭数据迁移工具

用法：
  heirloom-migrate <命令> [参数]

${c.bold('命令')}
  init       初始化实例（业务表 + migrator_* 基础设施 + 实例 ID）
  export     全量导出一个家庭（数据 + 媒体对象 + 清单/指纹）
  validate   导入前校验导出包与目标实例（阻断项/冲突明细，不改数据）
  apply      重映射标识并写入目标（幂等可重放，默认失败自动回滚）
  verify     迁移后逐行对账 + 外键完整性 + 媒体 sha256
  rollback   按迁移前快照回滚（数据行 + 媒体文件）
  status     查看迁移运行状态与行映射统计

${c.bold('常用参数')}
  --source-url / --target-url   源/目标连接串（postgres:// 或 pglite://）
  --family-id <cuid>            要导出的家庭 ID
  --bundle <dir>                导出包目录
  --migration-id <id>           迁移 ID（不传则自动生成；validate 给出后 apply 请沿用）
  --source-storage / --target-storage <dir>   媒体存储根目录（默认 \$STORAGE_ROOT）
  --state-dir <dir>             迁移状态/媒体旧文件备份目录
  --force                       允许对已完成迁移重放
  --no-auto-rollback            apply 失败时保留现场（用于断点续跑）
  --fail-after <N>              演练：处理 N 行后注入失败
  --report <file>               输出机器可读 JSON 报告

环境变量：DATABASE_URL / SOURCE_DATABASE_URL / TARGET_DATABASE_URL / STORAGE_ROOT
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  try {
    switch (command) {
      case 'init':
        await cmdInit(args);
        break;
      case 'export':
        await cmdExport(args);
        break;
      case 'validate':
        await cmdValidate(args);
        break;
      case 'apply':
        await cmdApply(args);
        break;
      case 'verify':
        await cmdVerify(args);
        break;
      case 'rollback':
        await cmdRollback(args);
        break;
      case 'status':
        await cmdStatus(args);
        break;
      default:
        console.log(HELP);
        if (command) process.exit(1);
    }
  } catch (err) {
    die((err as Error).message);
  }
}

void main();
