// src/utils/worktree-gc.ts — Stale factory worktree cleanup + credential scrub

import { exec as execCb } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { CLAIMED_BY_LABEL_PREFIX, PARKED_LABEL } from '../queue/github-queue.js';
import { branchPrefixSlug, shellEscape } from './index.js';
import { removeMicroVm, type WorktreeSandbox } from './microvm.js';

const exec = promisify(execCb);

export type GcReason = 'merged' | 'remote-gone' | 'ttl-expired' | 'issue-closed' | 'issue-parked';

/** GitHub's verdict on a candidate branch's PR(s), read via pulls.list (state=all,
 *  head=owner:branch). `null` means "no verdict" (no client/repo, or the query failed) —
 *  which must always fall back to the #639 local-evidence rules. */
export type GcHeadPrState = 'open' | 'merged' | 'closed' | 'none';

export interface WorktreeListEntry {
  path: string;
  head: string | null;
  branch: string | null;
}

export interface GcCandidate {
  path: string;
  branch: string | null;
  ageDays: number;
  reason: GcReason;
  scrubbedFiles: string[];
  /** True when the candidate's local branch was force-deleted after removal. False when the
   *  reason was not branch-reapable, when the candidate was detached, when this was a dry run,
   *  or when `git branch -D` failed (a warn is logged in that last case). */
  branchDeleted: boolean;
  /** Set at decision time for the issue-driven reasons (`issue-closed` / `issue-parked`): true
   *  only when the branch's content is provably on the remote (a PR ever existed, the remote
   *  branch is live, or the tip is an ancestor of origin/main). An unpushed parked attempt's
   *  branch stays as its only handle. */
  branchReapable?: boolean;
}

/** A factory-owned worktree whose lane-branch issue number could not be confirmed to exist on
 *  GitHub, surfaced only in the dry-run report (see ADR, this PR). */
export interface Issue404Candidate {
  path: string;
  branch: string | null;
  issue: number;
}

/** A factory-owned worktree whose branch's PR is merged or closed but whose owning issue has no
 *  active `factory:claimed-by:*` label, surfaced only in the dry-run report (see ADR, this PR). */
export interface NoActiveClaimCandidate {
  path: string;
  branch: string | null;
  issue: number;
  prState: 'merged' | 'closed';
}

export interface GcReport {
  removed: GcCandidate[];
  kept: number;
  dryRun: boolean;
  /** Dry-run only: factory-owned candidates whose lane issue number 404'd on GitHub — a strong
   *  signal the worktree was created for an issue that never existed. Never read by, or written
   *  from, GcReason/BRANCH_REAPABLE_REASONS. Always [] outside dry-run. */
  issueNotFound: Issue404Candidate[];
  /** Dry-run only: factory-owned candidates whose lane issue lookup threw a non-404 error (rate
   *  limit, network failure) — "couldn't check," never conflated with issueNotFound's "confirmed
   *  gone." Always [] outside dry-run. */
  issueUnverifiable: Issue404Candidate[];
  /** Dry-run only: factory-owned candidates whose branch's PR is merged or closed and whose
   *  owning issue carries no active `factory:claimed-by:*` label — the lane finished (or was
   *  abandoned) without releasing its worktree. Fail-safe: any doubt (no client/repo, lookup
   *  error, unresolved issue number) means "not flagged." Never read by, or written from,
   *  GcReason/BRANCH_REAPABLE_REASONS. Always [] outside dry-run. */
  noActiveClaim: NoActiveClaimCandidate[];
}

export interface SweepDeps {
  runCommand?: (cmd: string, opts?: { cwd?: string }) => Promise<{ stdout: string }>;
  now?: () => number;
  log?: (type: EventKind, msg: string) => void;
  /** When present (with opts.repo), merged/close status is sourced from GitHub; absent or failing ⇒ local evidence only. */
  octokit?: Pick<Octokit, 'rest'>;
  /** The repo's current docker-sandbox descriptor (runtime + authPaths), or undefined for every
   *  other runtime. A reaped candidate may have been provisioned under a different runtime than
   *  today's config, but removeMicroVm is a no-op unless `runtime === 'docker-sandbox'` and the
   *  named VM exists, so passing today's descriptor for every candidate is safe and idempotent. */
  sandbox?: WorktreeSandbox;
  /** Dedup tracker for resolveIssueDisposition's lookup-failure warning (see IssueWarnDedup).
   *  Defaults to a module-level singleton shared across every sweep in the process; tests should
   *  inject a fresh instance to avoid bleeding suppression state across cases. */
  issueWarnDedup?: IssueWarnDedup;
}

/** Dedupes resolveIssueDisposition's lookup-failure warning across repeated sweeps — the factory
 *  loop calls sweepWorktrees every iteration, and a worktree tied to a nonexistent issue number
 *  fails that lookup on every one of them. The first failure for a given issue since the last
 *  reconcile-clear warns in full; every following one folds into a one-line "suppressed N"
 *  summary instead of repeating the same text. `reconcile()` drops an issue's tracking once it's
 *  no longer among the sweep's candidates, so a later re-appearance (or a different worktree
 *  reusing the number) warns in full again. Keyed by issue number, not by worktree path, since
 *  the failing lookup is per-issue (see ADR, this PR). */
export class IssueWarnDedup {
  private readonly counts = new Map<number, number>();

  /** Records one occurrence for `issue`. Returns true the first time since the last
   *  reconcile-clear (caller should log the full warning), false thereafter. */
  record(issue: number): boolean {
    const count = (this.counts.get(issue) ?? 0) + 1;
    this.counts.set(issue, count);
    return count === 1;
  }

  /** Occurrences suppressed for `issue` since its last full warning (0 before the second one). */
  suppressedCount(issue: number): number {
    return Math.max(0, (this.counts.get(issue) ?? 0) - 1);
  }

  /** Drops tracking for every issue not in `activeIssues` — call once per sweep with the issue
   *  numbers still present among that sweep's candidates. */
  reconcile(activeIssues: ReadonlySet<number>): void {
    for (const issue of this.counts.keys()) {
      if (!activeIssues.has(issue)) this.counts.delete(issue);
    }
  }
}

const defaultIssueWarnDedup = new IssueWarnDedup();

const CREDENTIAL_BASENAMES = new Set(['.git-credentials', '.npmrc']);

/** Removal reasons that prove the work reached the remote — the only ones whose local
 *  branch is safe to force-delete unconditionally. `ttl-expired` fires on age alone and is
 *  excluded: its branch may be the last reachable handle on unpushed commits. The issue-driven
 *  reasons (`issue-closed` / `issue-parked`) are also excluded here — they delete the branch
 *  only when the candidate's per-candidate `branchReapable` flag proved remote evidence at
 *  decision time. See ADR (this PR). */
const BRANCH_REAPABLE_REASONS: ReadonlySet<GcReason> = new Set<GcReason>(['merged', 'remote-gone']);

export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  const blocks = porcelain
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  for (const block of blocks) {
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;

    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        branch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      }
    }

    if (path) {
      entries.push({ path, head, branch });
    }
  }

  return entries;
}

export function findCredentialFiles(worktreePath: string): string[] {
  const found: string[] = [];

  let topLevel: string[];
  try {
    topLevel = readdirSync(worktreePath);
  } catch {
    return found;
  }

  for (const name of topLevel) {
    if (name === '.env' || name.startsWith('.env.') || CREDENTIAL_BASENAMES.has(name)) {
      const filePath = join(worktreePath, name);
      try {
        if (statSync(filePath).isFile()) found.push(filePath);
      } catch {}
    }
  }

  const claudeDir = join(worktreePath, '.claude');
  if (existsSync(claudeDir)) {
    walkFiles(claudeDir, found);
  }

  return found;
}

function walkFiles(dir: string, found: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, found);
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
}

export function zeroFill(filePath: string): void {
  const size = statSync(filePath).size;
  writeFileSync(filePath, Buffer.alloc(size));
}

export function scrubFile(filePath: string): void {
  zeroFill(filePath);
  rmSync(filePath, { force: true });
}

async function defaultRunCommand(cmd: string, opts?: { cwd?: string }): Promise<{ stdout: string }> {
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

async function resolveMainTip(
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

/** The owning issue's verdict on a lane worktree. `null` means "no verdict" (no client/repo,
 *  or the query failed) and must always fall back to the PR-state/local-evidence rules. */
type IssueDisposition = 'reap-closed' | 'reap-parked' | 'keep';

/** The lane issue number a candidate belongs to: capture group 1 of the lane-branch shape
 *  `<prefix>/<n>-*`, falling back to a trailing `-<n>` in the directory basename (covers
 *  detached checkouts of factory-named paths). `null` when neither matches. */
function laneIssueNumber(entry: WorktreeListEntry, lanePattern: RegExp): number | null {
  const fromBranch = entry.branch?.match(lanePattern);
  if (fromBranch) return Number(fromBranch[1]);
  const fromPath = basename(entry.path).match(/-(\d+)$/);
  return fromPath ? Number(fromPath[1]) : null;
}

/** GitHub's verdict on the owning issue. A closed issue and a factory:parked label both mean
 *  the lane is finished-or-parked and its clean checkout is redundant (see ADR, this PR). */
async function resolveIssueDisposition(
  octokit: SweepDeps['octokit'],
  repo: string | undefined,
  issue: number,
  log: (type: EventKind, msg: string) => void,
  issueWarnDedup: IssueWarnDedup,
): Promise<IssueDisposition | null> {
  if (!octokit || !repo) return null;
  const [owner, repoName] = repo.split('/');
  try {
    const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
    if (data.state === 'closed') return 'reap-closed';
    const labels = (data.labels ?? []).map((label) => (typeof label === 'string' ? label : (label?.name ?? '')));
    if (labels.includes(PARKED_LABEL)) return 'reap-parked';
    return 'keep';
  } catch (err: any) {
    if (issueWarnDedup.record(issue)) {
      log(
        'warn',
        `worktree-gc: GitHub issue query failed for #${issue} (${err?.message ?? String(err)}) — using PR/local evidence only`,
      );
    } else {
      log(
        'warn',
        `worktree-gc: GitHub issue query failed for #${issue} — suppressed ${issueWarnDedup.suppressedCount(issue)} repeated warning(s) (using PR/local evidence only)`,
      );
    }
    return null;
  }
}

/** The lane issue's existence on GitHub, checked only for worktree-gc's dry-run report.
 *  'not-configured' (no client/repo) and 'error' (the call threw anything but a 404) both mean
 *  "no verdict" but are reported differently: 'error' surfaces as unverifiable so a rate-limit
 *  or network blip is never mistaken for a confirmed-gone issue. */
async function resolveIssueExistence(
  octokit: SweepDeps['octokit'],
  repo: string | undefined,
  issue: number,
  log: (type: EventKind, msg: string) => void,
): Promise<'exists' | 'not-found' | 'error' | 'not-configured'> {
  if (!octokit || !repo) return 'not-configured';
  const [owner, repoName] = repo.split('/');
  try {
    await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
    return 'exists';
  } catch (err: any) {
    if (err?.status === 404) return 'not-found';
    log(
      'warn',
      `worktree-gc: GitHub issue existence check failed for #${issue} (${err?.message ?? String(err)}) — reporting as unverifiable`,
    );
    return 'error';
  }
}

/** Whether the lane issue carries an active `factory:claimed-by:*` label, checked only for
 *  worktree-gc's dry-run report. Fail-safe: no client/repo, or a lookup error, both resolve to
 *  'unknown' — never conflated with a confirmed 'unclaimed' verdict. */
async function resolveActiveClaim(
  octokit: SweepDeps['octokit'],
  repo: string | undefined,
  issue: number,
  log: (type: EventKind, msg: string) => void,
): Promise<'claimed' | 'unclaimed' | 'unknown'> {
  if (!octokit || !repo) return 'unknown';
  const [owner, repoName] = repo.split('/');
  try {
    const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
    const labels = (data.labels ?? []).map((label: any) => (typeof label === 'string' ? label : (label?.name ?? '')));
    return labels.some((name: string) => name.startsWith(CLAIMED_BY_LABEL_PREFIX)) ? 'claimed' : 'unclaimed';
  } catch (err: any) {
    log(
      'warn',
      `worktree-gc: GitHub claim-label check failed for #${issue} (${err?.message ?? String(err)}) — reporting as unknown (not flagged)`,
    );
    return 'unknown';
  }
}

/** A worktree is clean when it has no modified tracked files. `--untracked-files=no` deliberately
 *  ignores untracked build residue (node_modules, artifacts) — the "live work" signal is tracked-file
 *  modifications. A probe failure (`safeExec` null) ⇒ false ⇒ keep. */
async function isWorktreeClean(
  runCommand: NonNullable<SweepDeps['runCommand']>,
  worktreePath: string,
): Promise<boolean> {
  const result = await safeExec(runCommand, 'git status --porcelain --untracked-files=no', { cwd: worktreePath });
  return result !== null && result.stdout.trim() === '';
}

export async function sweepWorktrees(
  opts: { repoRoot: string; ttlDays: number; dryRun?: boolean; repo?: string; branchPrefix?: string },
  deps: SweepDeps = {},
): Promise<GcReport> {
  const {
    runCommand = defaultRunCommand,
    now = () => Date.now(),
    log = () => {},
    octokit,
    sandbox,
    issueWarnDedup = defaultIssueWarnDedup,
  } = deps;
  const { repoRoot, ttlDays, dryRun = false, repo } = opts;

  const { stdout } = await runCommand('git worktree list --porcelain', { cwd: repoRoot });
  const entries = parseWorktreeList(stdout);

  const repoRootResolved = resolve(repoRoot);
  const repoBase = basename(repoRootResolved);
  const factoryPrefix = `${repoBase}-factory-`;
  // The slug is [a-z0-9-] only (branchPrefixSlug), so interpolating it into a regex is safe.
  const lanePattern = new RegExp('^' + branchPrefixSlug(opts.branchPrefix) + '/(\\d+)-');

  const candidates: WorktreeListEntry[] = entries.filter((entry) => {
    const entryPath = resolve(entry.path);
    if (entryPath === repoRootResolved) return false;
    const base = basename(entryPath);
    if (base.startsWith(factoryPrefix)) return true;
    // Legacy lane paths (<repo>-ship-it-<n>) predate the -factory- infix; there the checked-out
    // lane-branch shape is what proves factory ownership — manual/* and experiment worktrees
    // under a <repo>-* name never match it and are never candidates.
    return base.startsWith(`${repoBase}-`) && entry.branch !== null && lanePattern.test(entry.branch);
  });

  // Reconcile the issue-warn dedup tracker to this sweep's live candidates before resolving any
  // disposition, so a worktree that's gone (or an issue number no longer in play) drops its
  // suppression state and a later re-appearance warns in full again (see ADR, this PR).
  const activeIssueNumbers = new Set<number>();
  for (const entry of candidates) {
    const issueNumber = laneIssueNumber(entry, lanePattern);
    if (issueNumber !== null) activeIssueNumbers.add(issueNumber);
  }
  issueWarnDedup.reconcile(activeIssueNumbers);

  const removed: GcCandidate[] = [];
  let kept = 0;

  const mainTip = candidates.length > 0 ? await resolveMainTip(runCommand, repoRoot) : null;

  // Per-branch GitHub verdicts, memoized across the sweep (one pulls.list per candidate branch).
  const prStateCache = new Map<string, Promise<GcHeadPrState | null>>();
  const prStateFor = (branch: string): Promise<GcHeadPrState | null> => {
    let state = prStateCache.get(branch);
    if (!state) {
      state = resolvePrState(octokit, repo, branch, log);
      prStateCache.set(branch, state);
    }
    return state;
  };

  // Per-issue GitHub verdicts, memoized across the sweep (one issues.get per distinct lane issue).
  const dispositionCache = new Map<number, Promise<IssueDisposition | null>>();
  const dispositionFor = (issue: number): Promise<IssueDisposition | null> => {
    let disposition = dispositionCache.get(issue);
    if (!disposition) {
      disposition = resolveIssueDisposition(octokit, repo, issue, log, issueWarnDedup);
      dispositionCache.set(issue, disposition);
    }
    return disposition;
  };

  for (const entry of candidates) {
    const ageDays = computeAgeDays(entry.path, now, log);

    let pushEvidence: boolean | undefined;
    const priorPush = async (): Promise<boolean> => {
      if (!entry.branch) return false;
      if (pushEvidence === undefined) {
        pushEvidence = await hasPriorPushEvidence(runCommand, repoRoot, entry.branch);
      }
      return pushEvidence;
    };

    let reason: GcReason | null = null;
    let branchReapable = false;
    if (ageDays > ttlDays) {
      reason = 'ttl-expired';
    }
    if (!reason) {
      // Issue disposition outranks PR state (see ADR, this PR): a clean worktree whose owning
      // issue is closed or labeled factory:parked is garbage even while its PR is still open —
      // a finished or parked issue's open PR proves the work is pushed. No verdict, or a dirty
      // tree, falls through to the existing PR-state/local-evidence chain unchanged.
      const issueNumber = laneIssueNumber(entry, lanePattern);
      const disposition = issueNumber === null ? null : await dispositionFor(issueNumber);
      if (
        (disposition === 'reap-parked' || disposition === 'reap-closed') &&
        (await isWorktreeClean(runCommand, entry.path))
      ) {
        reason = disposition === 'reap-parked' ? 'issue-parked' : 'issue-closed';
        if (entry.branch) {
          const prState = await prStateFor(entry.branch);
          if (prState === 'open' || prState === 'merged' || prState === 'closed') {
            // A PR ever existed under this head ⇒ the branch was pushed.
            branchReapable = true;
          } else {
            const lsRemote = await safeExec(runCommand, `git ls-remote --heads origin ${shellEscape(entry.branch)}`, {
              cwd: repoRoot,
            });
            branchReapable =
              (lsRemote !== null && lsRemote.stdout.trim() !== '') ||
              (entry.head !== null &&
                (await safeExec(runCommand, `git merge-base --is-ancestor ${shellEscape(entry.head)} origin/main`, {
                  cwd: repoRoot,
                })) !== null);
          }
        }
      }
    }
    if (!reason && entry.branch) {
      const prState = await prStateFor(entry.branch);
      if (prState === 'open') {
        // A live PR is authoritative: the branch is still being worked on — never remove.
        reason = null;
      } else if (prState === 'merged') {
        // GitHub decided the branch is merged — authoritative on its own, no ancestry/push requirement.
        if (await isWorktreeClean(runCommand, entry.path)) reason = 'merged';
      } else if (prState === 'closed') {
        if (await isWorktreeClean(runCommand, entry.path)) {
          const delivered =
            entry.head !== null &&
            mainTip !== null &&
            (await safeExec(runCommand, `git merge-base --is-ancestor ${shellEscape(entry.head)} origin/main`, {
              cwd: repoRoot,
            })) !== null;
          if (delivered) {
            // Closed-not-merged PR whose content reached main — delivered, removable.
            reason = 'merged';
          } else {
            const lsRemote = await safeExec(runCommand, `git ls-remote --heads origin ${shellEscape(entry.branch)}`, {
              cwd: repoRoot,
            });
            if (lsRemote !== null && lsRemote.stdout.trim() === '') reason = 'remote-gone';
          }
        }
      } else {
        // prState is 'none' or null (no PR / GitHub unreachable / no client) — no GitHub verdict.
        // Fall back to the exact #639 local-evidence rules; every inconclusive probe keeps.
        const clean = await isWorktreeClean(runCommand, entry.path);
        if (clean && entry.head && mainTip !== null && entry.head !== mainTip) {
          const ancestorResult = await safeExec(
            runCommand,
            `git merge-base --is-ancestor ${shellEscape(entry.head)} origin/main`,
            { cwd: repoRoot },
          );
          // An ancestor HEAD alone is not proof of a merge: every lane worktree starts life at
          // origin/main (setupWorktree: `git worktree add -b <branch> <path> origin/main`), so a lane
          // that has not committed yet is trivially an ancestor. Require evidence the branch was
          // actually pushed before calling it merged.
          if (ancestorResult !== null && (await priorPush())) {
            reason = 'merged';
          }
        }
        if (!reason && clean) {
          const lsRemote = await safeExec(runCommand, `git ls-remote --heads origin ${shellEscape(entry.branch)}`, {
            cwd: repoRoot,
          });
          // An empty ls-remote is ambiguous — "merged and deleted upstream" or "never pushed". Only the
          // former is garbage, and only a prior push distinguishes them.
          if (lsRemote !== null && lsRemote.stdout.trim() === '' && (await priorPush())) {
            reason = 'remote-gone';
          }
        }
      }
    }

    if (!reason) {
      kept++;
      continue;
    }

    removed.push({
      path: entry.path,
      branch: entry.branch,
      ageDays,
      reason,
      scrubbedFiles: [],
      branchDeleted: false,
      branchReapable,
    });
  }

  if (dryRun) {
    const issueExistenceCache = new Map<number, Promise<'exists' | 'not-found' | 'error' | 'not-configured'>>();
    const issueExistenceFor = (issue: number) => {
      let p = issueExistenceCache.get(issue);
      if (!p) {
        p = resolveIssueExistence(octokit, repo, issue, log);
        issueExistenceCache.set(issue, p);
      }
      return p;
    };

    const issueNotFound: Issue404Candidate[] = [];
    const issueUnverifiable: Issue404Candidate[] = [];
    for (const entry of candidates) {
      const issueNumber = laneIssueNumber(entry, lanePattern);
      if (issueNumber === null) continue;
      const existence = await issueExistenceFor(issueNumber);
      if (existence === 'not-found') {
        issueNotFound.push({ path: entry.path, branch: entry.branch, issue: issueNumber });
      } else if (existence === 'error') {
        issueUnverifiable.push({ path: entry.path, branch: entry.branch, issue: issueNumber });
      }
    }

    const claimCache = new Map<number, Promise<'claimed' | 'unclaimed' | 'unknown'>>();
    const claimFor = (issue: number) => {
      let p = claimCache.get(issue);
      if (!p) {
        p = resolveActiveClaim(octokit, repo, issue, log);
        claimCache.set(issue, p);
      }
      return p;
    };

    const noActiveClaim: NoActiveClaimCandidate[] = [];
    for (const entry of candidates) {
      if (!entry.branch) continue;
      const prState = await prStateFor(entry.branch);
      if (prState !== 'merged' && prState !== 'closed') continue;
      const issueNumber = laneIssueNumber(entry, lanePattern);
      if (issueNumber === null) continue;
      const claim = await claimFor(issueNumber);
      if (claim === 'unclaimed') {
        noActiveClaim.push({ path: entry.path, branch: entry.branch, issue: issueNumber, prState });
      }
    }

    return { removed, kept, dryRun: true, issueNotFound, issueUnverifiable, noActiveClaim };
  }

  for (const candidate of removed) {
    const credentialFiles = findCredentialFiles(candidate.path);
    for (const filePath of credentialFiles) {
      try {
        scrubFile(filePath);
        candidate.scrubbedFiles.push(filePath);
      } catch (err: any) {
        log('warn', `failed to scrub ${filePath}: ${err?.message ?? String(err)}`);
      }
    }

    if (sandbox) {
      await removeMicroVm({ ...sandbox, worktreePath: candidate.path, log });
    }

    try {
      await runCommand(`git worktree remove --force ${shellEscape(candidate.path)}`, { cwd: repoRoot });
    } catch (err: any) {
      log('warn', `git worktree remove failed for ${candidate.path}: ${err?.message ?? String(err)}`);
      try {
        rmSync(candidate.path, { recursive: true, force: true });
      } catch (rmErr: any) {
        log('warn', `rmSync fallback failed for ${candidate.path}: ${rmErr?.message ?? String(rmErr)}`);
      }
    }
  }

  await runCommand('git worktree prune', { cwd: repoRoot }).catch((err: any) =>
    log('warn', `git worktree prune failed in ${repoRoot}: ${err?.message ?? String(err)}`),
  );

  await deleteReapedBranches(removed, repoRoot, runCommand, log);

  return { removed, kept, dryRun: false, issueNotFound: [], issueUnverifiable: [], noActiveClaim: [] };
}

async function deleteReapedBranches(
  candidates: GcCandidate[],
  repoRoot: string,
  runCommand: NonNullable<SweepDeps['runCommand']>,
  log: (type: EventKind, msg: string) => void,
): Promise<void> {
  for (const candidate of candidates) {
    if (candidate.branch === null) continue;
    if (!BRANCH_REAPABLE_REASONS.has(candidate.reason) && candidate.branchReapable !== true) continue;
    try {
      await runCommand(`git branch -D ${shellEscape(candidate.branch)}`, { cwd: repoRoot });
      candidate.branchDeleted = true;
    } catch (err: any) {
      log('warn', `git branch -D failed for ${candidate.branch}: ${err?.message ?? String(err)}`);
    }
  }
}

function computeAgeDays(worktreePath: string, now: () => number, log: (type: EventKind, msg: string) => void): number {
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

export function formatGcReport(report: GcReport): string {
  const lines: string[] = [];
  const verb = report.dryRun ? 'would remove' : 'removed';

  for (const candidate of report.removed) {
    const branchLabel = candidate.branch ?? 'detached';
    const age = Number.isFinite(candidate.ageDays) ? Math.floor(candidate.ageDays) : '∞';
    let line = `${candidate.path} (${branchLabel}, ${age}d old) — ${candidate.reason}`;
    if (candidate.scrubbedFiles.length > 0) {
      line += `, scrubbed ${candidate.scrubbedFiles.length} credential file(s)`;
    }
    if (candidate.branchDeleted && candidate.branch !== null) {
      line += `, deleted branch ${candidate.branch}`;
    }
    lines.push(line);
  }

  lines.push(`${verb} ${report.removed.length} worktree(s), kept ${report.kept}`);

  if (report.issueNotFound.length > 0) {
    lines.push(`${report.issueNotFound.length} worktree(s) flagged — owning issue not found (404):`);
    for (const c of report.issueNotFound) {
      lines.push(`  ${c.path} (${c.branch ?? 'detached'}) — issue #${c.issue} not found`);
    }
  }
  if (report.issueUnverifiable.length > 0) {
    lines.push(`${report.issueUnverifiable.length} worktree(s) unverifiable — GitHub issue lookup failed:`);
    for (const c of report.issueUnverifiable) {
      lines.push(`  ${c.path} (${c.branch ?? 'detached'}) — issue #${c.issue} unverifiable`);
    }
  }
  if (report.noActiveClaim.length > 0) {
    lines.push(`${report.noActiveClaim.length} worktree(s) flagged — merged/closed PR with no active claim:`);
    for (const c of report.noActiveClaim) {
      lines.push(`  ${c.path} (${c.branch ?? 'detached'}) — issue #${c.issue} ${c.prState}, no active claim`);
    }
  }

  return lines.join('\n');
}
