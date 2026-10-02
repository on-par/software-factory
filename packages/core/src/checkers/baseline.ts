// src/checkers/baseline.ts — re-run round-1 failing checkers on the base SHA in a temporary worktree (#1925)

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelRouter } from '../router/index.js';
import type { CheckerOutput, CheckResult, Constitution } from '../types/index.js';
import { runCommand } from '../utils/command-runner.js';
import { GIT_COMMAND_TIMEOUT_MS } from '../utils/git-exec.js';
import { DESIGN_SMELLS_CHECKER, WORKER_OUTPUT_CHECKER } from './design-smells.js';
import { type CheckerContext, runAllCheckers } from './index.js';

export type BaselineVerdict = 'clean-on-base' | 'fails-on-base' | 'not-run';

export interface BaselineCheckerComparison {
  checker: string;
  verdict: BaselineVerdict;
  /** The checker's result on the base SHA; absent when it was not run there. */
  baseResult?: CheckResult;
  /** Failing tests named by both the head and base output; present only when both name tests. */
  sharedFailingTests?: string[];
  /** Failing tests named by the head output but not the base output; present only when both name tests. */
  newFailingTests?: string[];
  /** Why the checker was not run on base (verdict 'not-run'). */
  reason?: string;
}

export interface BaselineReport {
  baseSha: string;
  checkers: BaselineCheckerComparison[];
  /** Set when the base worktree could not be created or the base run threw. */
  error?: string;
}

export interface BaselineDeps {
  runCommand?: typeof runCommand;
  runCheckers?: typeof runAllCheckers;
  /** Creates the empty parent directory for the temporary worktree. */
  makeTempDir?: () => Promise<string>;
}

export interface BaselineOptions {
  baseSha: string;
  /** The issue's worktree; git commands run here, its files are never changed. */
  laneWorktree: string;
  /** Round-1 checker outputs (only FAIL entries are considered). */
  failing: readonly CheckerOutput[];
  /** The round's checker context; its env (laneEnv) is reused unchanged. */
  ctx: CheckerContext;
  router: ModelRouter;
  constitution: Constitution | null;
  customCheckerTimeoutSeconds?: number;
  deps?: BaselineDeps;
}

/** Checkers that grade the change diff, which is empty at the base SHA. */
const DIFF_SCOPED = new Set([WORKER_OUTPUT_CHECKER, DESIGN_SMELLS_CHECKER]);

function notRunnableReason(name: string): string | null {
  if (DIFF_SCOPED.has(name)) return 'graded against the change diff, not runnable on base';
  if (name.startsWith('custom_')) return 'agent checker graded against the spec, not run on base';
  return null;
}

/** Failing test names in checker output, deduped in first-seen order. */
export function extractFailingTestNames(details: string): string[] {
  const names = details
    .split(/\r?\n/)
    .flatMap(
      (line) =>
        line.match(/(?:\bFAIL|[×✕●])\s+(.+)/)?.[1] ??
        line.match(/\bnot ok \d+\s*-\s*(.+)/i)?.[1] ??
        // .NET Microsoft.Testing.Platform: "failed Namespace.Class.Test (46ms)"
        line.match(/\bfailed\s+(\S+)\s+\(\d/)?.[1] ??
        [],
    )
    .map((identifier) => identifier.trim())
    .filter((identifier) => identifier !== '');
  return [...new Set(names)];
}

export function compareBaseline(
  head: readonly CheckerOutput[],
  base: readonly CheckerOutput[],
): BaselineCheckerComparison[] {
  const comparisons: BaselineCheckerComparison[] = [];
  for (const h of head) {
    if (h.result !== 'FAIL') continue;
    const checker = h.checker;
    const reason = notRunnableReason(checker);
    if (reason !== null) {
      comparisons.push({ checker, verdict: 'not-run', reason });
      continue;
    }
    const b = base.find((o) => o.checker === checker);
    if (!b) {
      comparisons.push({ checker, verdict: 'not-run', reason: 'no result on base' });
      continue;
    }
    if (b.result !== 'FAIL') {
      comparisons.push({ checker, verdict: 'clean-on-base', baseResult: b.result });
      continue;
    }
    const comparison: BaselineCheckerComparison = { checker, verdict: 'fails-on-base', baseResult: 'FAIL' };
    const headTests = extractFailingTestNames(h.details);
    const baseTests = extractFailingTestNames(b.details);
    if (headTests.length > 0 && baseTests.length > 0) {
      comparison.sharedFailingTests = headTests.filter((t) => baseTests.includes(t));
      comparison.newFailingTests = headTests.filter((t) => !baseTests.includes(t));
    }
    comparisons.push(comparison);
  }
  return comparisons;
}

export async function runBaselineCheckers(opts: BaselineOptions): Promise<BaselineReport> {
  const { baseSha, laneWorktree, failing, ctx, router, constitution, customCheckerTimeoutSeconds, deps = {} } = opts;
  const runnable = failing
    .filter((o) => o.result === 'FAIL' && notRunnableReason(o.checker) === null)
    .map((o) => o.checker);
  if (runnable.length === 0) return { baseSha, checkers: compareBaseline(failing, []) };

  const run = deps.runCommand ?? runCommand;
  const runCheckers = deps.runCheckers ?? runAllCheckers;
  const makeTempDir = deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), 'factory-baseline-')));

  const parent = await makeTempDir();
  const baseWorktree = join(parent, 'base');
  const add = await run(['git', 'worktree', 'add', '--detach', baseWorktree, baseSha], {
    cwd: laneWorktree,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (add.exitCode !== 0) {
    await rm(parent, { recursive: true, force: true });
    return {
      baseSha,
      checkers: compareBaseline(failing, []),
      error: `git worktree add failed: ${(add.stderr || add.stdout).trim().slice(0, 300)}`,
    };
  }

  try {
    const summary = await runCheckers(
      { ...ctx, worktree: baseWorktree, probe: undefined, diffBase: baseSha },
      router,
      constitution,
      customCheckerTimeoutSeconds,
      runnable,
    );
    return { baseSha, checkers: compareBaseline(failing, summary.results) };
  } catch (e: any) {
    return {
      baseSha,
      checkers: compareBaseline(failing, []),
      error: `baseline run failed: ${(e?.message ?? String(e)).slice(0, 300)}`,
    };
  } finally {
    await removeBaseWorktree(run, laneWorktree, parent, baseWorktree);
  }
}

/** Removes only our worktree; never throws. */
async function removeBaseWorktree(
  run: typeof runCommand,
  laneWorktree: string,
  parent: string,
  baseWorktree: string,
): Promise<void> {
  try {
    const r = await run(['git', 'worktree', 'remove', '--force', baseWorktree], {
      cwd: laneWorktree,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) {
      await rm(baseWorktree, { recursive: true, force: true });
      await run(['git', 'worktree', 'prune'], { cwd: laneWorktree, timeoutMs: GIT_COMMAND_TIMEOUT_MS });
    }
  } catch {
    // cleanup is best-effort
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => {});
  }
}
