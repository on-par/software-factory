// src/utils/index.ts — Shared utilities: logging, git ops, cost tracking, shell helpers

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import { createLogger } from '../logger/index.js';
import type { CostEntry, FailoverReason, LogLevel, ReadinessInfo, ReworkInfo } from '../types/index.js';
import { levelForType } from './format.js';
import { execGit } from './git-exec.js';
import { createMicroVm, removeMicroVm, type WorktreeSandbox } from './microvm.js';

export type { WorktreeSandbox } from './microvm.js';

export { colorEnabled, formatEventLine, levelForType } from './format.js';

// ---------- Event Logging ----------

export function logEvent(
  eventsFile: string,
  type: EventKind,
  issue: string | number,
  msg: string,
  extra?: {
    failoverReason?: FailoverReason;
    lane?: string;
    phase?: string;
    level?: LogLevel;
    rework?: ReworkInfo;
    readiness?: ReadinessInfo;
    actor?: string;
    model?: string;
    tokens?: { input: number; output: number };
  },
): void {
  const logger = createLogger(eventsFile, { issue, lane: extra?.lane, phase: extra?.phase });
  const level = extra?.level ?? levelForType(type);
  const meta: {
    failoverReason?: FailoverReason;
    rework?: ReworkInfo;
    readiness?: ReadinessInfo;
    actor?: string;
    model?: string;
    tokens?: { input: number; output: number };
  } = {};
  if (extra?.failoverReason) meta.failoverReason = extra.failoverReason;
  if (extra?.rework) meta.rework = extra.rework;
  if (extra?.readiness) meta.readiness = extra.readiness;
  if (extra?.actor) meta.actor = extra.actor;
  if (extra?.model) meta.model = extra.model;
  if (extra?.tokens) meta.tokens = extra.tokens;
  logger[level](type, msg, Object.keys(meta).length > 0 ? meta : undefined);
}

// ---------- Cost Tracking ----------

export function logCost(costsFile: string, entry: Omit<CostEntry, 'ts'>): void {
  const full: CostEntry = { ...entry, ts: new Date().toISOString() };
  const line = JSON.stringify(full) + '\n';
  try {
    appendFileSync(costsFile, line);
  } catch {
    mkdirSync(resolve(costsFile, '..'), { recursive: true });
    appendFileSync(costsFile, line);
  }
}

export function readCosts(costsFile: string): CostEntry[] {
  if (!existsSync(costsFile)) return [];
  return readFileSync(costsFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as CostEntry];
      } catch {
        return [];
      }
    });
}

// ---------- Git Operations ----------

// Every git call below runs through execGit, which imposes a hard deadline and
// kills the child on expiry. Without one, a wedged worktree op hangs its caller
// forever with no output — the failure mode #755 was opened for.
export async function gitFetch(repoRoot: string): Promise<void> {
  await execGit('git fetch origin -q --prune', { cwd: repoRoot });
}

/** The repo default branch's remote-tracking ref (from origin/HEAD), or
 *  'origin/main' when origin/HEAD is unset (e.g. a clone of an empty bare repo). */
export async function defaultRemoteBase(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execGit('git symbolic-ref -q refs/remotes/origin/HEAD', { cwd: repoRoot });
    const m = stdout.trim().match(/^refs\/remotes\/(origin\/.+)$/);
    if (m) return m[1];
  } catch {
    // fall through — origin/HEAD unset or not a repo; caller keeps the historical default
  }
  return 'origin/main';
}

export async function setupWorktree(
  repoRoot: string,
  branch: string,
  worktreePath: string,
  startPoint?: string,
  sandbox?: WorktreeSandbox,
  log?: (type: EventKind, msg: string) => void,
): Promise<void> {
  // The base of record is the freshly fetched remote-tracking ref — never local
  // branch state, which can be stale, dirty, or ahead (#1167).
  await gitFetch(repoRoot);
  const base = startPoint ?? (await defaultRemoteBase(repoRoot));
  await execGit(`git worktree remove --force ${shellEscape(worktreePath)}`, { cwd: repoRoot }).catch(() => {});
  await execGit(`git branch -D ${shellEscape(branch)}`, { cwd: repoRoot }).catch(() => {});
  await execGit(`git worktree add -b ${shellEscape(branch)} ${shellEscape(worktreePath)} ${shellEscape(base)}`, {
    cwd: repoRoot,
  });
  const { stdout } = await execGit('git rev-parse --verify HEAD', { cwd: worktreePath });
  log?.('worktree-base', `created from ${base} @ ${stdout.trim()}`);
  if (sandbox) {
    await createMicroVm({ ...sandbox, worktreePath, log });
  }
}

export async function cleanupWorktree(
  repoRoot: string,
  worktreePath: string,
  log: (type: EventKind, msg: string) => void = () => {},
  sandbox?: WorktreeSandbox,
): Promise<void> {
  if (sandbox) {
    await removeMicroVm({ ...sandbox, worktreePath, log });
  }
  await execGit(`git worktree remove --force ${shellEscape(worktreePath)}`, { cwd: repoRoot }).catch((err: any) =>
    log(
      'warn',
      `git worktree remove failed for ${worktreePath}: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`,
    ),
  );
  await execGit('git worktree prune', { cwd: repoRoot }).catch((err: any) =>
    log(
      'warn',
      `git worktree prune failed in ${repoRoot}: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`,
    ),
  );
}

export interface LaneWorktreeReapResult {
  outcome: 'removed' | 'kept-dirty' | 'kept-branch-mismatch' | 'absent';
  branch: string | null;
  branchDeleted: boolean;
}

/**
 * Eagerly removes a lane's own worktree when the lane parks or fails (#1007), fail-closed:
 * the checked-out branch must match `<prefix>/<issue>-*` (a human checkout squatting the lane
 * path is left alone), the tree must have no modified tracked files, and the local branch is
 * deleted only when its content is provably on the remote — an unpushed parked attempt's
 * branch survives as its only handle. Every probe failure means keep. A registered-but-deleted
 * path returns `absent` (pruning it is sweepWorktrees' job).
 */
export async function reapLaneWorktree(
  repoRoot: string,
  worktreePath: string,
  opts: {
    issue: number;
    branchPrefix?: string;
    log?: (type: EventKind, msg: string) => void;
    sandbox?: WorktreeSandbox;
  },
): Promise<LaneWorktreeReapResult> {
  const log = opts.log ?? (() => {});
  if (!existsSync(worktreePath)) {
    return { outcome: 'absent', branch: null, branchDeleted: false };
  }

  const lanePrefix = `${branchPrefixSlug(opts.branchPrefix)}/${opts.issue}-`;
  const branch = await execGit('git rev-parse --abbrev-ref HEAD', { cwd: worktreePath }).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  if (branch === null || !branch.startsWith(lanePrefix)) {
    log(
      'warn',
      `worktree at ${worktreePath} is on '${branch ?? 'unknown'}', not a ${lanePrefix}* lane branch — leaving it alone`,
    );
    return { outcome: 'kept-branch-mismatch', branch, branchDeleted: false };
  }

  const status = await execGit('git status --porcelain --untracked-files=no', { cwd: worktreePath }).catch(() => null);
  if (status === null || status.stdout.trim() !== '') {
    log(
      'warn',
      `parked worktree ${worktreePath} has modified tracked files — kept; review it or run 'factory worktree gc' / 'factory doctor --reconcile'`,
    );
    return { outcome: 'kept-dirty', branch, branchDeleted: false };
  }

  const tip = await execGit('git rev-parse HEAD', { cwd: worktreePath }).then(
    (r) => r.stdout.trim(),
    () => null,
  );

  await cleanupWorktree(repoRoot, worktreePath, log, opts.sandbox);

  const lsRemote = await execGit(`git ls-remote --heads origin ${shellEscape(branch)}`, { cwd: repoRoot }).catch(
    () => null,
  );
  const onRemote =
    (lsRemote !== null && lsRemote.stdout.trim() !== '') ||
    (tip !== null &&
      (await execGit(`git merge-base --is-ancestor ${shellEscape(tip)} origin/main`, { cwd: repoRoot }).then(
        () => true,
        () => false,
      )));

  let branchDeleted = false;
  if (onRemote) {
    try {
      await execGit(`git branch -D ${shellEscape(branch)}`, { cwd: repoRoot });
      branchDeleted = true;
    } catch (err: any) {
      log(
        'warn',
        `git branch -D failed for ${branch}: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`,
      );
    }
  } else {
    log(
      'worktree-gc',
      `kept branch ${branch} — its content is not on the remote, so it is the only handle to the parked attempt`,
    );
  }

  log(
    'worktree-gc',
    `removed lane worktree ${worktreePath} for issue #${opts.issue}${branchDeleted ? `, deleted branch ${branch}` : ''}`,
  );
  return { outcome: 'removed', branch, branchDeleted };
}

export function slugify(s: string): string {
  // The [^a-z0-9]+ pass always collapses runs of non-alphanumeric characters to a
  // single '-', so at most one '-' can ever remain at either boundary below — a `+`
  // quantifier there would be redundant and is a polynomial-backtracking regex on
  // attacker-controlled input (CodeQL js/polynomial-redos).
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-$/, '');
}

export function branchPrefixSlug(prefix?: string): string {
  return slugify(prefix || 'ship-it') || 'ship-it';
}

export function branchFor(issue: number, title: string, prefix?: string): string {
  return `${branchPrefixSlug(prefix)}/${issue}-${slugify(title)}`;
}

export async function getIssueTitle(repo: string, issue: number, octokit: any): Promise<string> {
  const { data } = await octokit.rest.issues.get({
    owner: repo.split('/')[0],
    repo: repo.split('/')[1],
    issue_number: issue,
  });
  return data.title;
}

// ---------- Shell helpers ----------

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------- File helpers ----------

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function readJsonIfExists<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

// ---------- Escalation ----------

/**
 * Shared escalation predicate. An output escalates iff some line begins with `ESCALATE:`.
 * Line-start semantics (stricter): a mid-paragraph mention of ESCALATE: in prose does NOT count.
 * Used by both production phases and the eval scorer so evals match production behavior.
 */
export function isEscalation(output: string): boolean {
  return output.split('\n').some((line) => line.startsWith('ESCALATE:'));
}

/** The first `ESCALATE:`-prefixed line, or undefined when the output is not an escalation. */
export function escalationLine(output: string): string | undefined {
  return output.split('\n').find((line) => line.startsWith('ESCALATE:'));
}
