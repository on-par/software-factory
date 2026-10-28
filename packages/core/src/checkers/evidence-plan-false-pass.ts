import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { EvidencePlanEntry } from '@on-par/contracts';

import { withTempDir } from '../harness/temp-dir.js';
import { execGit } from '../utils/git-exec.js';
import type { EvidencePlanResult, EvidenceRunnerContext } from './evidence-plan.js';
import { stripAnsi } from './command-log.js';
import { BASE_REF_CANDIDATES } from './design-smells.js';

const SHA = /^[0-9a-f]{40,64}$/i;
const DETAIL_LIMIT = 2000;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(-DETAIL_LIMIT);
}

function failure(
  entry: EvidencePlanEntry,
  reason: string,
  head: EvidencePlanResult,
  baseSha?: string,
): EvidencePlanResult {
  return {
    ...head,
    claim: entry.claim,
    status: 'FAIL',
    reason: `claim ${entry.claim}: ${reason}`.slice(-DETAIL_LIMIT),
    ...(baseSha ? { baseSha } : {}),
  };
}

async function resolveCommit(ref: string, cwd: string): Promise<string | null> {
  try {
    const output = (await execGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })).stdout.trim();
    return SHA.test(output) ? output : null;
  } catch {
    return null;
  }
}

async function resolveBase(ctx: EvidenceRunnerContext): Promise<string> {
  if (ctx.parentBaseRef !== undefined) {
    const parent = await resolveCommit(ctx.parentBaseRef, ctx.worktree);
    if (!parent) throw new Error(`base ref override '${ctx.parentBaseRef}' does not resolve to a commit`);
    return parent;
  }
  for (const candidate of BASE_REF_CANDIDATES) {
    const commit = await resolveCommit(candidate, ctx.worktree);
    if (commit) return commit;
  }
  if (ctx.diffBase !== undefined) {
    const fallback = await resolveCommit(ctx.diffBase, ctx.worktree);
    if (fallback) return fallback;
  }
  throw new Error('no base ref resolves (tried origin/main, origin/master, then diffBase)');
}

function describeRun(label: string, run: EvidencePlanResult['headRun']): string {
  if (!run) return `${label} has no completed run record`;
  const state = run.timedOut ? 'timed out' : run.killed ? 'was terminated' : `exited ${run.exitCode}`;
  return `${label} ${state}`;
}

const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s|m)\b/g;

function normalizeSignature(tail: string | undefined, paths: string[]): string[] {
  let text = stripAnsi(tail ?? '');
  for (const path of paths) if (path) text = text.split(path).join('<worktree>');
  return text
    .replace(DURATION, '<t>')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-20);
}

function sharedFailureLine(
  entry: EvidencePlanEntry,
  head: EvidencePlanResult['headRun'],
  base: EvidencePlanResult['headRun'],
  paths: string[],
): string | undefined {
  if (entry.kind !== 'fail-to-pass-test' || !head || !base) return undefined;
  if (head.timedOut || head.killed || base.timedOut || base.killed) return undefined;
  if (head.exitCode !== base.exitCode || head.exitCode === 0) return undefined;
  const headSignature = normalizeSignature(head.outputTail, paths);
  const baseSignature = normalizeSignature(base.outputTail, paths);
  if (headSignature.length === 0 || headSignature.length !== baseSignature.length) return undefined;
  if (headSignature.some((line, index) => line !== baseSignature[index])) return undefined;
  return `fail-to-pass ${entry.test} failed identically on base and head (exit ${head.exitCode}): ${headSignature[headSignature.length - 1]}`.slice(
    0,
    300,
  );
}

export async function verifyFailToPass(
  entry: EvidencePlanEntry,
  head: EvidencePlanResult,
  ctx: EvidenceRunnerContext,
  runBase: (worktree: string) => Promise<EvidencePlanResult>,
): Promise<EvidencePlanResult> {
  if (head.status === 'SKIP') return head;

  let baseSha: string | undefined;
  let mergeBaseSha: string | undefined;
  let baseRun: EvidencePlanResult['headRun'];
  let baseWorktree: string | undefined;
  let primaryError: string | undefined;
  let cleanupError: string | undefined;
  try {
    baseSha = await resolveBase(ctx);
    const mergeBaseOutput = (await execGit(['merge-base', baseSha, 'HEAD'], { cwd: ctx.worktree })).stdout.trim();
    if (!SHA.test(mergeBaseOutput)) throw new Error('git merge-base returned an invalid commit SHA');
    const resolvedMergeBase = mergeBaseOutput;
    mergeBaseSha = resolvedMergeBase;
    baseSha = mergeBaseSha;

    await withTempDir('factory-evidence-base-', async (parent) => {
      const worktree = join(parent, 'base');
      baseWorktree = worktree;
      let addAttempted = false;
      try {
        addAttempted = true;
        await execGit(['worktree', 'add', '--detach', worktree, resolvedMergeBase], { cwd: ctx.worktree });
        const base = await runBase(worktree);
        baseRun = base.headRun;
        if (base.status === 'SKIP') throw new Error(`base execution unexpectedly skipped: ${base.reason}`);
      } finally {
        if (addAttempted) {
          try {
            await execGit(['worktree', 'remove', '--force', worktree], { cwd: ctx.worktree });
          } catch (error) {
            const removeMessage = message(error);
            try {
              await rm(worktree, { recursive: true, force: true, maxRetries: 3 });
              await execGit(['worktree', 'prune'], { cwd: ctx.worktree });
            } catch (fallbackError) {
              cleanupError = `worktree removal failed: ${removeMessage}; cleanup fallback failed: ${message(fallbackError)}`;
            }
            if (!cleanupError)
              cleanupError = `worktree removal failed; filesystem cleanup fallback used: ${removeMessage}`;
          }
        }
      }
    });
  } catch (error) {
    primaryError = message(error);
  }

  if (primaryError || cleanupError) {
    const detail = [primaryError ? `base verification inconclusive: ${primaryError}` : '', cleanupError]
      .filter(Boolean)
      .join('; ');
    return failure(
      entry,
      `${detail}; ${describeRun('head', head.headRun)}; ${describeRun('base', baseRun)}`,
      {
        ...head,
        ...(baseRun ? { baseRun } : {}),
      },
      baseSha,
    );
  }

  const headDescription = describeRun('head', head.headRun);
  const baseDescription = describeRun('base', baseRun);
  const baseProvesFailure = Boolean(baseRun && !baseRun.timedOut && !baseRun.killed && baseRun.exitCode !== 0);
  const headPasses = head.status === 'PASS' && head.headRun && !head.headRun.timedOut && !head.headRun.killed;
  let status: EvidencePlanResult['status'] = 'FAIL';
  let comparison: string;
  let sharedFailure: string | undefined;
  if (headPasses && baseProvesFailure) {
    status = 'PASS';
    comparison = `merge-base ${mergeBaseDescription(mergeBaseSha)}: ${baseDescription}; head: ${headDescription}`;
  } else if (baseRun?.exitCode === 0 && !baseRun.timedOut && !baseRun.killed) {
    comparison = `test doesn't exercise the change; claim ${entry.claim}; merge-base: ${baseDescription}; head: ${headDescription}`;
  } else {
    comparison = `inconclusive fail-to-pass proof; merge-base: ${baseDescription}; head: ${headDescription}`;
    sharedFailure = sharedFailureLine(entry, head.headRun, baseRun, [ctx.worktree, baseWorktree ?? '']);
    if (sharedFailure) comparison += `; ${sharedFailure}`;
  }
  return {
    ...head,
    status,
    reason: `claim ${entry.claim}: ${comparison}`.slice(-DETAIL_LIMIT),
    ...(baseRun ? { baseRun } : {}),
    ...(baseSha ? { baseSha } : {}),
    ...(sharedFailure ? { sharedFailure } : {}),
  };
}

function mergeBaseDescription(baseSha: string | undefined): string {
  return baseSha ?? 'unknown commit';
}
