import { isAbsolute, relative } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { fenceExcerpt } from '../filing/sanitize.js';
import type { CheckSummary, FailurePhase } from '../types/index.js';
import { execGit } from '../utils/git-exec.js';
import type { WorkKey } from '../work/work-key.js';
import { upsertMarkerComment } from './park-comment.js';
import type { RunStopReason } from './run-stop.js';

export const HANDOFF_VERSION = 1;
const MAX_FAILURE_CHARS = 2000;
const WIP_IDENTITY = ['-c', 'user.name=Software Factory', '-c', 'user.email=factory@users.noreply.github.com'];

export type HandoffCriterionStatus = 'done' | 'failing' | 'not_started';

export interface HandoffCriterion {
  criterion: string;
  status: HandoffCriterionStatus;
  proof: string | null;
}

export interface RemainingWorkHandoff {
  version: typeof HANDOFF_VERSION;
  stopReason: RunStopReason;
  phase: FailurePhase;
  baseSha: string | null;
  wipBranch: string | null;
  headSha: string | null;
  specPath: string | null;
  criteria: HandoffCriterion[];
  lastFailure: string | null;
  nextStep: string;
  fitsOneRun: boolean;
}

export interface WipSave {
  baseSha: string | null;
  wipBranch: string | null;
  headSha: string | null;
  error?: string;
}

type Git = (args: readonly string[]) => Promise<string>;

export function handoffMarker(issue: WorkKey): string {
  return `<!-- factory-handoff v${HANDOFF_VERSION} issue:${issue} -->`;
}

export function wipBranchFor(branch: string): string {
  return `wip/${branch}`;
}

export function splitProof(line: string): { criterion: string; proof: string | null } {
  const at = line.search(/\bproof:/i);
  if (at === -1) return { criterion: line.trim(), proof: null };
  const proof = line.slice(at + 'proof:'.length).trim();
  return { criterion: line.slice(0, at).trim(), proof: proof === '' ? null : proof };
}

function failingChecks(summary: CheckSummary | undefined): string[] {
  return summary?.results.filter((r) => r.result === 'FAIL').map((r) => r.checker) ?? [];
}

function lastFailure(summary: CheckSummary | undefined): string | null {
  const lines = summary?.results.filter((r) => r.result === 'FAIL').map((r) => `${r.checker}: ${r.details}`) ?? [];
  if (lines.length === 0) return null;
  const text = lines.join('\n');
  return text.length <= MAX_FAILURE_CHARS ? text : `…${text.slice(-MAX_FAILURE_CHARS)}`;
}

function nextStep(phase: FailurePhase, planned: boolean, branch: string | null, failing: string[]): string {
  const from = branch ?? 'the run branch';
  if (!planned) return 'Start a new run; PLAN did not finish.';
  if (phase === 'plan' || phase === 'build') return `Finish BUILD from ${from}, then run CHECK.`;
  if (failing.length > 0) return `Fix ${failing.join(', ')} on ${from}, then re-run CHECK.`;
  return `CHECK passed; ship ${from}.`;
}

export function buildHandoff(input: {
  stopReason: RunStopReason;
  phase: FailurePhase;
  planned: boolean;
  specPath: string;
  worktree: string;
  criteria: readonly string[];
  summary?: CheckSummary;
  wip: WipSave;
}): RemainingWorkHandoff {
  const { phase, planned, summary, wip } = input;
  const checked = summary !== undefined && (phase === 'check' || phase === 'ship');
  const status: HandoffCriterionStatus = !checked ? 'not_started' : summary.failures > 0 ? 'failing' : 'done';
  const rel = relative(input.worktree, input.specPath);
  const failing = checked ? failingChecks(summary) : [];
  return {
    version: HANDOFF_VERSION,
    stopReason: input.stopReason,
    phase,
    baseSha: wip.baseSha,
    wipBranch: wip.wipBranch,
    headSha: wip.headSha,
    specPath: planned ? (rel.startsWith('..') || isAbsolute(rel) ? input.specPath : rel) : null,
    criteria: input.criteria.map((line) => ({ ...splitProof(line), status })),
    lastFailure: checked ? lastFailure(summary) : null,
    nextStep: nextStep(phase, planned, wip.wipBranch, failing),
    fitsOneRun: planned && (phase === 'check' || phase === 'ship'),
  };
}

export function handoffNote(h: RemainingWorkHandoff): string {
  const left = h.criteria.filter((c) => c.status !== 'done').length;
  const stop = h.stopReason === 'sigterm' ? 'SIGTERM' : 'the run deadline';
  return `budget exhausted: ${stop} stopped the run during ${h.phase.toUpperCase()}; ${left} of ${h.criteria.length} criteria left; WIP ${h.wipBranch ?? '-'} @ ${h.headSha?.slice(0, 12) ?? '-'}. Next: ${h.nextStep}`;
}

export function renderHandoffComment(issue: WorkKey, h: RemainingWorkHandoff): string {
  const mark = { done: 'x', failing: ' ', not_started: ' ' } as const;
  const criteria = h.criteria.map(
    (c) => `- [${mark[c.status]}] ${c.criterion} (${c.status})${c.proof ? ` proof: ${c.proof}` : ''}`,
  );
  return [
    '### Factory remaining-work handoff',
    '',
    handoffNote(h),
    '',
    ...(criteria.length > 0 ? ['**Acceptance criteria**', '', ...criteria, ''] : []),
    ...(h.lastFailure ? ['**Last failing check**', '', fenceExcerpt(h.lastFailure), ''] : []),
    '<details><summary>handoff JSON</summary>',
    '',
    fenceExcerpt(JSON.stringify(h, null, 2)),
    '',
    '</details>',
    '',
    handoffMarker(issue),
  ].join('\n');
}

async function tryGit(git: Git, args: readonly string[]): Promise<string | null> {
  try {
    return (await git(args)).trim() || null;
  } catch {
    return null;
  }
}

export async function saveWip(opts: {
  worktree: string;
  branch: string;
  issue: WorkKey;
  phase: FailurePhase;
  baseRef?: string;
  push: boolean;
  git?: Git;
}): Promise<WipSave> {
  const git: Git = opts.git ?? (async (args) => (await execGit(args, { cwd: opts.worktree, noPrompt: true })).stdout);
  const wipBranch = wipBranchFor(opts.branch);
  const baseSha = await tryGit(git, ['merge-base', 'HEAD', opts.baseRef ?? 'origin/HEAD']);
  try {
    if ((await git(['status', '--porcelain'])).trim() !== '') {
      await git(['add', '-A']);
      const message = `wip(#${opts.issue}): run stopped during ${opts.phase}`;
      await git(['commit', '--no-verify', '-m', message]).catch(() =>
        git([...WIP_IDENTITY, 'commit', '--no-verify', '-m', message]),
      );
    }
    const headSha = (await git(['rev-parse', 'HEAD'])).trim();
    await git(['branch', '-f', wipBranch, headSha]);
    if (opts.push) await git(['push', '--force', 'origin', `${headSha}:refs/heads/${wipBranch}`]);
    return { baseSha, wipBranch, headSha };
  } catch (err) {
    const headSha = await tryGit(git, ['rev-parse', 'HEAD']);
    return { baseSha, wipBranch: null, headSha, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function postHandoffComment(deps: {
  octokit: Octokit;
  repo: string;
  issue: WorkKey;
  handoff: RemainingWorkHandoff;
}): Promise<{ commentId: number; created: boolean }> {
  const marker = handoffMarker(deps.issue);
  const body = renderHandoffComment(deps.issue, deps.handoff);
  return upsertMarkerComment({ octokit: deps.octokit, repo: deps.repo, issue: deps.issue, marker, body });
}
