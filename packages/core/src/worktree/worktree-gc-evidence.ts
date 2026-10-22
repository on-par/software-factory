// src/worktree/worktree-gc-evidence.ts — gathers one evidence record per worktree for decideWorktree

import { exec as execCb } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import type { EventKind } from '../events/kinds.js';
import { shellEscape } from '../utils/index.js';
import {
  claimOf,
  dispositionOf,
  existenceOf,
  fetchIssueRecord,
  type IssueDisposition,
  type IssueRecord,
} from './worktree-gc-issues.js';
import type { GcHeadPrState, IssueWarnDedup, SweepDeps, WorktreeListEntry } from './worktree-gc-types.js';
import type { WorktreeKeep } from './worktree-keeps.js';

const exec = promisify(execCb);

export async function defaultRunCommand(cmd: string, opts?: { cwd?: string }): Promise<{ stdout: string }> {
  const { stdout } = await exec(cmd, opts);
  return { stdout: stdout.toString() };
}

function safeExec(
  runCommand: NonNullable<SweepDeps['runCommand']>,
  cmd: string,
  opts?: { cwd?: string },
): Promise<{ stdout: string } | null> {
  return runCommand(cmd, opts).catch(() => null);
}

export async function resolveMainTip(
  runCommand: NonNullable<SweepDeps['runCommand']>,
  repoRoot: string,
): Promise<string | null> {
  const result = await safeExec(runCommand, 'git rev-parse --verify origin/main', { cwd: repoRoot });
  const sha = result?.stdout.trim() ?? '';
  return sha === '' ? null : sha;
}

async function hasPriorPushEvidence(
  runCommand: NonNullable<SweepDeps['runCommand']>,
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  const trackingRef = await safeExec(
    runCommand,
    `git rev-parse --verify --quiet ${shellEscape(`refs/remotes/origin/${branch}`)}`,
    { cwd: repoRoot },
  );
  if (trackingRef !== null && trackingRef.stdout.trim() !== '') return true;

  const reflog = await safeExec(
    runCommand,
    `git reflog show --no-abbrev ${shellEscape(`refs/remotes/origin/${branch}`)}`,
    { cwd: repoRoot },
  );
  if (reflog !== null && reflog.stdout.trim() !== '') return true;

  const upstream = await safeExec(runCommand, `git config --get ${shellEscape(`branch.${branch}.merge`)}`, {
    cwd: repoRoot,
  });
  // git sets branch.<name>.merge automatically at worktree-creation time from the start point
  // (e.g. `git worktree add -b <branch> <path> origin/main` sets it to refs/heads/main), so a
  // non-empty value alone is not proof of a push. Only `git push -u origin <branch>` points it at
  // the branch's own ref — require that exact match.
  return upstream !== null && upstream.stdout.trim() === `refs/heads/${branch}`;
}

/** GitHub's verdict on the branch's PRs. `null` when no client/repo is available or the query
 *  fails — the caller must then fall back to local evidence (fail-safe: keep on doubt). */
async function resolvePrState(
  octokit: SweepDeps['octokit'],
  repo: string | undefined,
  branch: string,
  log: (type: EventKind, msg: string) => void,
): Promise<GcHeadPrState | null> {
  if (!octokit || !repo) return null;
  const [owner, repoName] = repo.split('/');
  try {
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo: repoName,
      state: 'all',
      head: `${owner}:${branch}`,
    });
    if (data.some((pr) => pr.state === 'open')) return 'open';
    const merged = data.find((pr) => pr.merged_at != null);
    if (merged) return 'merged';
    if (data.some((pr) => pr.state === 'closed')) return 'closed';
    return 'none';
  } catch (err: any) {
    log(
      'warn',
      `worktree-gc: GitHub PR query failed for ${branch} (${err?.message ?? String(err)}) — using local evidence only`,
    );
    return null;
  }
}

/** The lane issue number a candidate belongs to: capture group 1 of the lane-branch shape
 *  `<prefix>/<n>-*`, falling back to a trailing `-<n>` in the directory basename (covers
 *  detached checkouts of factory-named paths). `null` when neither matches. */
export function laneIssueNumber(entry: WorktreeListEntry, lanePattern: RegExp): number | null {
  const fromBranch = entry.branch?.match(lanePattern);
  if (fromBranch) return Number(fromBranch[1]);
  const fromPath = basename(entry.path).match(/-(\d+)$/);
  return fromPath ? Number(fromPath[1]) : null;
}

/** A worktree is clean when it has no modified tracked files. `--untracked-files=no` deliberately
 *  ignores untracked build residue (node_modules, artifacts) — the "live work" signal is tracked-file
 *  modifications. A probe failure (`safeExec` null) ⇒ false ⇒ keep. */
export async function isWorktreeClean(
  runCommand: NonNullable<SweepDeps['runCommand']>,
  worktreePath: string,
): Promise<boolean> {
  const result = await safeExec(runCommand, 'git status --porcelain --untracked-files=no', { cwd: worktreePath });
  return result !== null && result.stdout.trim() === '';
}

/** Commits reachable from `rev` that are on no `origin` ref; null when the probe fails or is unparseable (⇒ keep). */
export async function countUnpushedCommits(
  runCommand: NonNullable<SweepDeps['runCommand']>,
  repoRoot: string,
  rev: string,
): Promise<number | null> {
  const result = await safeExec(runCommand, `git rev-list --count ${shellEscape(rev)} --not --remotes=origin`, {
    cwd: repoRoot,
  });
  const n = result === null ? NaN : Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(n) ? n : null;
}

/** True only when `head` has exactly 0 commits ahead of origin/main — a lane that has not committed
 *  yet (every lane starts at origin/main), never proof of a merge (#2964). Probe failure ⇒ false. */
export async function isZeroCommitLane(
  runCommand: NonNullable<SweepDeps['runCommand']>,
  repoRoot: string,
  head: string | null,
): Promise<boolean> {
  if (head === null) return false;
  const result = await safeExec(runCommand, `git rev-list --count origin/main..${shellEscape(head)}`, {
    cwd: repoRoot,
  });
  return result !== null && result.stdout.trim() === '0';
}

export function computeAgeDays(
  worktreePath: string,
  now: () => number,
  log: (type: EventKind, msg: string) => void,
): number {
  const gitPath = join(worktreePath, '.git');
  try {
    const mtimeMs = statSync(gitPath).mtimeMs;
    return (now() - mtimeMs) / (24 * 60 * 60 * 1000);
  } catch (err: any) {
    // An inconclusive probe must never mean "delete" — this directory may hold the only copy of
    // uncommitted work.
    log('warn', `worktree-gc: cannot stat ${gitPath} (${err?.message ?? String(err)}) — treating as age 0 (keeping)`);
    return 0;
  }
}

export interface WorktreeEvidence {
  path: string;
  branch: string | null;
  head: string | null;
  /** laneIssueNumber(entry, lanePattern) */
  issue: number | null;
  protected: boolean;
  keep: { issue: number; reason: string } | null;
  ageDays: number;
  disposition: IssueDisposition | null;
  existence: 'exists' | 'not-found' | 'error' | 'not-configured';
  claim: 'claimed' | 'unclaimed' | 'unknown';
  /** The lookup's error message when the issue record is not-found or error (dry-run warn text). */
  issueError?: string;
  /** null when the branch is null, or GitHub gave no verdict. */
  prState: GcHeadPrState | null;
  git: {
    clean: boolean;
    /** isZeroCommitLane(head); also the decomposed-parent branchReapable probe. */
    zeroCommit: boolean;
    priorPush: boolean;
    /** `git ls-remote --heads origin <branch>`; null on probe failure or a null branch. */
    remoteBranch: 'present' | 'absent' | null;
    headIsAncestorOfMain: boolean;
    mainTip: string | null;
    unpushedCount: number | null;
  };
}

export interface EvidenceContext {
  repoRoot: string;
  repo: string | undefined;
  dryRun: boolean;
  lanePattern: RegExp;
  protectedIssues: ReadonlySet<number> | undefined;
  keeps: ReadonlyMap<number, WorktreeKeep>;
  mainTip: string | null;
  runCommand: NonNullable<SweepDeps['runCommand']>;
  now: () => number;
  log: (type: EventKind, msg: string) => void;
  octokit: SweepDeps['octokit'];
  issueWarnDedup: IssueWarnDedup;
  issueRecords: Map<number, Promise<IssueRecord>>;
  prStates: Map<string, Promise<GcHeadPrState | null>>;
}

export function createEvidenceContext(
  opts: {
    repoRoot: string;
    repo?: string;
    dryRun: boolean;
    lanePattern: RegExp;
    protectedIssues?: ReadonlySet<number>;
    keeps: ReadonlyMap<number, WorktreeKeep>;
    mainTip: string | null;
  },
  deps: Required<Pick<SweepDeps, 'runCommand' | 'now' | 'log'>> &
    Pick<SweepDeps, 'octokit'> & { issueWarnDedup: IssueWarnDedup },
): EvidenceContext {
  return {
    repoRoot: opts.repoRoot,
    repo: opts.repo,
    dryRun: opts.dryRun,
    lanePattern: opts.lanePattern,
    protectedIssues: opts.protectedIssues,
    keeps: opts.keeps,
    mainTip: opts.mainTip,
    runCommand: deps.runCommand,
    now: deps.now,
    log: deps.log,
    octokit: deps.octokit,
    issueWarnDedup: deps.issueWarnDedup,
    issueRecords: new Map(),
    prStates: new Map(),
  };
}

function issueRecordFor(ctx: EvidenceContext, issue: number): Promise<IssueRecord> {
  let record = ctx.issueRecords.get(issue);
  if (!record) {
    record = fetchIssueRecord(ctx.octokit, ctx.repo, issue, ctx.log, ctx.issueWarnDedup);
    ctx.issueRecords.set(issue, record);
  }
  return record;
}

function prStateFor(ctx: EvidenceContext, branch: string): Promise<GcHeadPrState | null> {
  let state = ctx.prStates.get(branch);
  if (!state) {
    state = resolvePrState(ctx.octokit, ctx.repo, branch, ctx.log);
    ctx.prStates.set(branch, state);
  }
  return state;
}

const NO_GIT: WorktreeEvidence['git'] = {
  clean: false,
  zeroCommit: false,
  priorPush: false,
  remoteBranch: null,
  headIsAncestorOfMain: false,
  mainTip: null,
  unpushedCount: null,
};

async function gatherGitEvidence(
  ctx: EvidenceContext,
  entry: WorktreeListEntry,
  prState: GcHeadPrState | null,
): Promise<WorktreeEvidence['git']> {
  const { runCommand, repoRoot } = ctx;
  const { branch, head } = entry;
  const lsRemote = branch
    ? await safeExec(runCommand, `git ls-remote --heads origin ${shellEscape(branch)}`, { cwd: repoRoot })
    : null;
  const ancestor =
    head === null
      ? null
      : await safeExec(runCommand, `git merge-base --is-ancestor ${shellEscape(head)} origin/main`, { cwd: repoRoot });
  return {
    clean: await isWorktreeClean(runCommand, entry.path),
    zeroCommit: await isZeroCommitLane(runCommand, repoRoot, head),
    // Only the no-PR-verdict local-evidence rules consult push history.
    priorPush:
      branch && (prState === null || prState === 'none')
        ? await hasPriorPushEvidence(runCommand, repoRoot, branch)
        : false,
    remoteBranch: lsRemote === null ? null : lsRemote.stdout.trim() === '' ? 'absent' : 'present',
    headIsAncestorOfMain: ancestor !== null,
    mainTip: ctx.mainTip,
    unpushedCount: head ? await countUnpushedCommits(runCommand, repoRoot, head) : null,
  };
}

/** Collects every fact decideWorktree may consult. Probes are read-only, so gathering them up
 *  front cannot change their answers. A protected entry skips git probes (and, outside dry-run,
 *  GitHub lookups: dry-run's diagnostics cover every candidate). */
export async function gatherWorktreeEvidence(
  ctx: EvidenceContext,
  entry: WorktreeListEntry,
): Promise<WorktreeEvidence> {
  const issue = laneIssueNumber(entry, ctx.lanePattern);
  const isProtected = issue !== null && ctx.protectedIssues?.has(issue) === true;
  const base = { path: entry.path, branch: entry.branch, head: entry.head, issue, protected: isProtected };
  const lookUp = !isProtected || ctx.dryRun;

  const record: IssueRecord = lookUp && issue !== null ? await issueRecordFor(ctx, issue) : { kind: 'not-configured' };
  const prState = lookUp && entry.branch ? await prStateFor(ctx, entry.branch) : null;
  const issueFields = {
    disposition: issue === null ? null : dispositionOf(record, issue),
    existence: existenceOf(record),
    claim: issue === null ? ('unknown' as const) : claimOf(record, issue),
    ...(record.kind === 'error' || record.kind === 'not-found' ? { issueError: record.message } : {}),
  };

  if (isProtected) {
    return { ...base, keep: null, ageDays: 0, ...issueFields, prState, git: NO_GIT };
  }
  const keep = issue === null ? undefined : ctx.keeps.get(issue);
  return {
    ...base,
    keep: keep ? { issue: keep.issue, reason: keep.reason } : null,
    ageDays: computeAgeDays(entry.path, ctx.now, ctx.log),
    ...issueFields,
    prState,
    git: await gatherGitEvidence(ctx, entry, prState),
  };
}
