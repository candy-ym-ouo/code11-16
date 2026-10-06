#!/usr/bin/env node
/**
 * 跨实例家庭数据迁移工具。
 *
 * 用法：
 *   tsx src/migration/cli.ts export   --family <家庭ID> --out <目录>
 *   tsx src/migration/cli.ts validate --bundle <迁移包目录>
 *   tsx src/migration/cli.ts import   --bundle <迁移包目录> [--dry-run]
 *   tsx src/migration/cli.ts verify   --bundle <迁移包目录> --run <批次ID>
 *   tsx src/migration/cli.ts rollback --run <批次ID>
 *   tsx src/migration/cli.ts list
 *
 * 源端：DATABASE_URL / STORAGE_ROOT（.env 或环境变量）
 * 目标端：TARGET_DATABASE_URL / TARGET_STORAGE_ROOT
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { exportFamily } from './exporter';
import { importFamily } from './importer';
import { preflight, postVerify } from './preflight';
import { rollbackRun } from './snapshot';
import { bundlePath, readManifest } from './bundle';
import { makeClient, resolveEndpoints } from './clients';

interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i]!;
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return { command, flags };
}

const c = {
  info: (msg: string) => safeLog(`\x1b[1m[迁移]\x1b[0m ${msg}`),
  ok: (msg: string) => safeLog(`\x1b[32m[通过]\x1b[0m ${msg}`),
  warn: (msg: string) => safeLog(`\x1b[33m[警告]\x1b[0m ${msg}`),
  err: (msg: string) => safeLog(`\x1b[31m[失败]\x1b[0m ${msg}`),
};

// 输出被管道关闭（如 | head）时不能让 EPIPE 中断回滚这类已经在执行的收尾动作
function safeLog(msg: string): void {
  try {
    process.stdout.write(msg + '\n');
  } catch {
    // 忽略 EPIPE
  }
}

function usage(): never {
  console.log(
    [
      '跨实例家庭数据迁移工具',
      '',
      '用法：migrate:<命令> [参数]',
      '',
      '命令：',
      '  export     导出一个家庭的全部数据到迁移包',
      '               --family <家庭ID> --out <输出目录，默认 data/exports/migration>',
      '  validate   只做目标端校验，不写数据',
      '               --bundle <迁移包目录>',
      '  import     校验并导入（失败自动标记，可重放续跑，可回滚）',
      '               --bundle <迁移包目录> [--dry-run] [--skip-preflight]',
      '  verify     导入后复核行数与媒体哈希',
      '               --bundle <迁移包目录> --run <批次ID>',
      '  rollback   按批次回滚到迁移前快照',
      '               --run <批次ID> [--yes]',
      '  list       列出目标端迁移批次',
      '',
      '环境变量：',
      '  DATABASE_URL / STORAGE_ROOT          源端数据库与媒体存储',
      '  TARGET_DATABASE_URL / TARGET_STORAGE_ROOT  目标端（不填则与源端相同）',
    ].join('\n'),
  );
  process.exit(1);
}

function printCheck(title: string, result: { ok: boolean; errors: string[]; warnings: string[]; info: string[] }): void {
  c.info(title);
  for (const i of result.info) console.log(`         ${i}`);
  for (const w of result.warnings) c.warn(w);
  for (const e of result.errors) c.err(e);
  if (result.ok) c.ok(`${title}通过`);
  else c.err(`${title}未通过`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const endpoints = resolveEndpoints();
  const source = makeClient(endpoints.sourceUrl);
  const usingSameEndpoint = endpoints.sourceUrl === endpoints.targetUrl && endpoints.sourceStorageRoot === endpoints.targetStorageRoot;
  const target: PrismaClient = usingSameEndpoint ? source : makeClient(endpoints.targetUrl);

  try {
    switch (command) {
      case 'export': {
        const family = String(flags.family ?? '');
        if (!family) usage();
        const out = String(flags.out ?? path.join(process.cwd(), 'data/exports/migration'));
        await fsp.mkdir(out, { recursive: true });
        c.info(`导出家庭 ${family}（源端 ${endpoints.sourceUrl.split('@')[1] ?? endpoints.sourceUrl}）`);
        const result = await exportFamily(source, endpoints.sourceStorageRoot, {
          familyId: family,
          outDir: out,
          onProgress: c.info,
        });
        c.ok(`迁移包已生成：${result.bundleDir}`);
        console.log(JSON.stringify({ bundleId: result.manifest.bundleId, counts: result.manifest.counts }, null, 2));
        break;
      }

      case 'validate': {
        const bundleDir = bundlePath(String(flags.bundle ?? ''));
        const manifest = await readManifest(bundleDir);
        c.info(`校验迁移包 ${bundleDir}（目标端）`);
        const result = await preflight(target, bundleDir, manifest, {
          targetStorageRoot: endpoints.targetStorageRoot,
          allowResume: true,
          onProgress: c.info,
        });
        printCheck('目标端校验', result);
        process.exitCode = result.ok ? 0 : 1;
        break;
      }

      case 'import': {
        const bundleDir = bundlePath(String(flags.bundle ?? ''));
        const manifest = await readManifest(bundleDir);
        c.info(`导入迁移包 ${bundleDir}`);
        c.info(`源端：${manifest.source.familyName}（${manifest.source.familyId}）`);

        if (!flags['skip-preflight']) {
          const check = await preflight(target, bundleDir, manifest, {
            targetStorageRoot: endpoints.targetStorageRoot,
            allowResume: true,
            onProgress: c.info,
          });
          printCheck('目标端校验', check);
          if (!check.ok) {
            c.err('校验未通过，导入中止。修复问题后重新执行即可（已做的工作不会重复）。');
            process.exit(1);
          }
        } else {
          c.warn('已跳过目标端校验（--skip-preflight）');
        }

        const result = await importFamily(target, endpoints.targetStorageRoot, bundleDir, manifest, {
          dryRun: !!flags['dry-run'],
          targetFamilyId: typeof flags['target-family'] === 'string' ? flags['target-family'] : undefined,
          onProgress: c.info,
        });

        c.ok(flags['dry-run'] ? 'dry-run 完成' : `导入完成，批次 ${result.runId}`);
        safeLog(JSON.stringify(result.stats, null, 2));

        if (!flags['dry-run']) {
          const verify = await postVerify(
            target,
            endpoints.targetStorageRoot,
            manifest,
            result.targetFamilyId,
            result.stats,
          );
          printCheck('导入后复核', verify);
          if (!verify.ok) {
            c.err(`复核未通过。可执行回滚：pnpm migrate:rollback --run ${result.runId}`);
            process.exitCode = 1;
          }
        }
        break;
      }

      case 'verify': {
        const bundleDir = bundlePath(String(flags.bundle ?? ''));
        const runId = String(flags.run ?? '');
        const manifest = await readManifest(bundleDir);
        const run = await target.migrationRun.findUnique({ where: { id: runId } });
        if (!run) {
          c.err(`找不到批次 ${runId}`);
          process.exit(1);
        }
        const inserted = (run.stats as { inserted?: Record<string, number> } | null)?.inserted ?? {};
        const result = await postVerify(target, endpoints.targetStorageRoot, manifest, run.targetFamily ?? '', {
          inserted,
          mergedUsers: [],
        });
        printCheck(`批次 ${runId} 复核`, result);
        process.exitCode = result.ok ? 0 : 1;
        break;
      }

      case 'rollback': {
        const runId = String(flags.run ?? '');
        if (!runId) usage();
        const run = await target.migrationRun.findUnique({ where: { id: runId } });
        if (!run) {
          c.err(`找不到批次 ${runId}`);
          process.exit(1);
        }
        c.warn(`即将回滚批次 ${runId}（bundle ${run.bundleId}，目标家庭 ${run.targetFamily ?? run.sourceFamily}）`);
        c.warn('回滚会删除本次迁移写入的全部数据库行并还原媒体文件。');
        if (!flags.yes) {
          c.err('需要显式确认：追加 --yes 执行回滚。');
          process.exit(1);
        }
        const result = await rollbackRun(target, endpoints.targetStorageRoot, runId, c.info);
        c.ok('回滚完成');
        safeLog(JSON.stringify(result, null, 2));
        break;
      }

      case 'list': {
        const runs = await target.migrationRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 });
        if (runs.length === 0) {
          c.info('目标端暂无迁移批次记录');
          break;
        }
        for (const r of runs) {
          const stats = r.stats as { mergedUsers?: unknown[] } | null;
          console.log(
            `${r.id}  ${r.status.padEnd(7)} ${r.startedAt.toISOString()}  bundle=${r.bundleId.slice(0, 12)}  family=${r.targetFamily ?? '-'}${stats?.mergedUsers?.length ? `  合并用户 ${stats.mergedUsers.length}` : ''}`,
          );
        }
        break;
      }

      default:
        usage();
    }
  } finally {
    await source.$disconnect();
    if (target !== source) await target.$disconnect();
  }
}

main().catch((err) => {
  c.err(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
