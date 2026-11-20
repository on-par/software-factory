import type { Octokit } from '@octokit/rest';
import type { EventKind } from '@on-par/factory-core';
import {
  classifyHeadChecks,
  fetchRequiredContexts,
  listAllCheckRuns,
  warnNoBranchProtectionOnce,
} from '@on-par/factory-core/internal';
import { AwaitingCiError, CiFailedError, CiUnverifiedError, LandConflictError } from './land-errors.js';
import { landRuntime } from './land-runtime.js';

type NoWaitLog = (type: EventKind, msg: string) => void;

interface NoWaitTarget {
  issue: number;
  prNumber: number;
  branch: string;
  log: NoWaitLog;
}

interface NoWaitRead extends NoWaitTarget {
  octokit: Octokit;
  owner: string;
  repo: string;
  behindProbe: (headSha: string, baseRef: string) => Promise<boolean | undefined>;
}

function conflict({ issue, prNumber, branch, log }: NoWaitTarget, base: string): LandConflictError {
  const msg = `PR #${prNumber} on ${branch} conflicts with ${base} — no-wait land does not sync; parked`;
  log('conflict', msg);
  return new LandConflictError(`issue #${issue}: ${msg}`);
}

export function refuseNoWaitSync(reason: string, target: NoWaitTarget): Error {
  if (reason === 'dirty') return conflict(target, 'main');
  const msg = `PR #${target.prNumber} on ${target.branch} needs a sync with main (${reason}) — no-wait land does not sync or merge an unverified head`;
  target.log('awaiting-ci', msg);
  return new CiUnverifiedError(msg, target.prNumber);
}

async function readPullAndChecks(ctx: NoWaitRead) {
  const { octokit, owner, repo, prNumber, branch, log } = ctx;
  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const base = pr.base.ref;
    const required = await fetchRequiredContexts(octokit, { owner, repo, branch: base }).catch((): string[] => []);
    const runs = await listAllCheckRuns(octokit, owner, repo, pr.head.sha, 100, 10);
    const checks = classifyHeadChecks(
      required,
      runs.map((r) => ({ name: r.name ?? '', status: r.status ?? null, conclusion: r.conclusion ?? null })),
    );
    if (checks.basis === 'all-on-head') warnNoBranchProtectionOnce(`${owner}/${repo}`, base, (m) => log('warn', m));
    return { pr, base, checks };
  } catch (err) {
    const msg = `CI read for ${branch} failed: ${landRuntime().errorDetail(err)} — refusing to merge without a green verdict`;
    log('ci-failed', msg);
    throw new CiUnverifiedError(msg, prNumber);
  }
}

export async function verifyHeadOnce(ctx: NoWaitRead): Promise<string> {
  const { prNumber, branch, log } = ctx;
  const { pr, base, checks } = await readPullAndChecks(ctx);
  const headSha = pr.head.sha;
  const pending = (why: string): AwaitingCiError => {
    const msg = `PR #${prNumber} on ${branch}: ${why} — no-wait land leaves the PR open without merging`;
    log('awaiting-ci', msg);
    return new AwaitingCiError(msg, prNumber, headSha);
  };
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') throw conflict(ctx, base);
  const behind = await ctx.behindProbe(headSha, base).catch(() => undefined);
  if (pr.mergeable_state === 'behind' || behind === true) throw pending(`head ${headSha} needs a sync with ${base}`);
  if (checks.state === 'failed') {
    const msg = `CI failed for PR #${prNumber} on ${branch} (${checks.failed.join(', ')}) — refusing to merge with a failing check`;
    log('ci-failed', msg);
    throw new CiFailedError(msg, prNumber);
  }
  if (checks.state === 'pending') {
    const waiting = [...checks.missing, ...checks.pending];
    throw pending(`checks not finished on ${headSha}${waiting.length > 0 ? ` (${waiting.join(', ')})` : ''}`);
  }
  if (pr.mergeable !== true) throw pending(`mergeability of ${headSha} is not known yet`);
  return headSha;
}
