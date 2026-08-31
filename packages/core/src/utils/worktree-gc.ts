// src/utils/worktree-gc.ts — Stale factory worktree cleanup + credential scrub

import { exec as execCb } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { shellEscape } from './index.js';
import { removeMicroVm, type WorktreeSandbox } from './microvm.js';

const exec = promisify(execCb);

export type GcReason = 'merged' | 'remote-gone' | 'ttl-expired';

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
}

export interface GcReport {
  removed: GcCandidate[];
  kept: number;
  dryRun: boolean;
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
}

const CREDENTIAL_BASENAMES = new Set(['.git-credentials', '.npmrc']);

/** Removal reasons that prove the work reached the remote — the only ones whose local
 *  branch is safe to force-delete. `ttl-expired` fires on age alone and is excluded:
 *  its branch may be the last reachable handle on unpushed commits. See ADR (this PR). */
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
  opts: { repoRoot: string; ttlDays: number; dryRun?: boolean; repo?: string },
  deps: SweepDeps = {},
): Promise<GcReport> {
  const { runCommand = defaultRunCommand, now = () => Date.now(), log = () => {}, octokit, sandbox } = deps;
  const { repoRoot, ttlDays, dryRun = false, repo } = opts;

  const { stdout } = await runCommand('git worktree list --porcelain', { cwd: repoRoot });
  const entries = parseWorktreeList(stdout);

  const repoRootResolved = resolve(repoRoot);
  const repoBase = basename(repoRootResolved);
  const factoryPrefix = `${repoBase}-factory-`;

  const candidates: WorktreeListEntry[] = entries.filter((entry) => {
    const entryPath = resolve(entry.path);
    if (entryPath === repoRootResolved) return false;
    return basename(entryPath).startsWith(factoryPrefix);
  });

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
    if (ageDays > ttlDays) {
      reason = 'ttl-expired';
    } else if (entry.branch) {
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
    });
  }

  if (dryRun) {
    return { removed, kept, dryRun: true };
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

  return { removed, kept, dryRun: false };
}

async function deleteReapedBranches(
  candidates: GcCandidate[],
  repoRoot: string,
  runCommand: NonNullable<SweepDeps['runCommand']>,
  log: (type: EventKind, msg: string) => void,
): Promise<void> {
  for (const candidate of candidates) {
    if (candidate.branch === null) continue;
    if (!BRANCH_REAPABLE_REASONS.has(candidate.reason)) continue;
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

  return lines.join('\n');
}
