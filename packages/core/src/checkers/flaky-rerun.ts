// src/checkers/flaky-rerun.ts — serial re-run of a failing tests checker (#2291, #2301)
import { extractFailingTestNames } from './baseline.js';
import type { CommandResult } from '../utils/command-runner.js';
import {
  type CheckerContext,
  getPackageJson,
  resolveTestsCommand,
  type TestsCommand,
  writeCommandLog,
} from './index.js';
import type { PackageJson } from './probe.js';
import { runVerificationCommand } from './run-command.js';

export const RERUN_TIMEOUT_MS = 600_000;

export interface RerunPlan {
  mode: 'targeted' | 'full';
  argv: string[];
  timeoutMs: number;
  /** Test identifiers the targeted argv selects; [] for a full re-run. */
  tests: string[];
}

function full(cmd: TestsCommand): RerunPlan {
  return { mode: 'full', argv: [...cmd.argv], timeoutMs: RERUN_TIMEOUT_MS, tests: [] };
}

function testNamePattern(name: string): string {
  return name
    .replace(/^.* > /, '')
    .replace(/\s+\d+(?:\.\d+)?ms$/, '')
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildRerunPlan(cmd: TestsCommand, pkg: PackageJson | null, details: string): RerunPlan {
  if (cmd.runner === 'pytest') {
    const ids = extractFailingTestNames(details).filter((n) => n.includes('::'));
    if (ids.length === 0) return full(cmd);
    return { mode: 'targeted', argv: ['python3', '-m', 'pytest', ...ids], timeoutMs: RERUN_TIMEOUT_MS, tests: ids };
  }
  if (cmd.runner === 'npm') {
    const script = pkg?.scripts?.test ?? '';
    const flag = /\bvitest\b/.test(script) ? '--no-file-parallelism' : /\bjest\b/.test(script) ? '--runInBand' : null;
    if (flag === null) return full(cmd);
    const names = [...new Set(extractFailingTestNames(details).map(testNamePattern).filter(Boolean))];
    if (names.length === 0) return full(cmd);
    return {
      mode: 'targeted',
      argv: ['npm', 'test', '--', '-t', names.join('|'), flag],
      timeoutMs: RERUN_TIMEOUT_MS,
      tests: names,
    };
  }
  return full(cmd);
}

export interface FlakeRerun {
  verdict: 'passed' | 'reproduced' | 'not-run';
  mode: RerunPlan['mode'];
  /** RerunPlan.tests: [] for a full re-run. */
  tests: string[];
  /** Full-output log (<outputLogDir>/flaky-rerun-tests.log); absent when no outputLogDir or the write failed. */
  logPath?: string;
  /** Why the verdict is not-run. */
  reason?: string;
}

export async function rerunFailingTests({ ctx, plan }: { ctx: CheckerContext; plan: RerunPlan }): Promise<FlakeRerun> {
  const base = { mode: plan.mode, tests: plan.tests };
  if (plan.argv.length === 0) return { ...base, verdict: 'not-run', reason: 'no tests command' };
  let r: CommandResult;
  try {
    r = await (ctx.runCommand ?? runVerificationCommand)(plan.argv, {
      cwd: ctx.worktree,
      timeoutMs: plan.timeoutMs,
      env: ctx.env,
      onPgid: ctx.onPgid,
    });
  } catch (e: any) {
    return { ...base, verdict: 'not-run', reason: String(e?.message ?? e).slice(0, 300) };
  }
  const logPath = (await writeCommandLog(ctx, 'flaky-rerun-tests', r)) ?? undefined;
  const withLog = logPath === undefined ? base : { ...base, logPath };
  if (r.timedOut) return { ...withLog, verdict: 'not-run', reason: `timed out after ${plan.timeoutMs / 1000}s` };
  return { ...withLog, verdict: r.ok ? 'passed' : 'reproduced' };
}

/** Resolve + plan + run for the failing `tests` checker; never throws (#2301). */
export async function rerunTestsChecker(ctx: CheckerContext, details: string): Promise<FlakeRerun> {
  try {
    const cmd = await resolveTestsCommand(ctx);
    const plan = buildRerunPlan(cmd, await getPackageJson(ctx), details);
    return await rerunFailingTests({ ctx, plan });
  } catch (e: any) {
    return { verdict: 'not-run', mode: 'full', tests: [], reason: String(e?.message ?? e).slice(0, 300) };
  }
}
