// src/worktree/worktree-gc.ts — Stale factory worktree cleanup: gather evidence, decide, execute

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import { getFactoryPaths } from '../config/index.js';
import { factoryBranchPrefixes, shellEscape } from '../utils/index.js';
import { removeMicroVm } from '../utils/microvm.js';
import { decideWorktree } from './worktree-gc-decide.js';
import {
  createEvidenceContext,
  defaultRunCommand,
  gatherWorktreeEvidence,
  laneIssueNumber,
  resolveMainTip,
  type WorktreeEvidence,
} from './worktree-gc-evidence.js';
import { findCredentialFiles, scrubFile } from './worktree-gc-scrub.js';
import {
  type GcCandidate,
  type GcHeldCandidate,
  type GcKeptCandidate,
  type GcReason,
  type GcReport,
  defaultIssueWarnDedup,
  type Issue404Candidate,
  type NoActiveClaimCandidate,
  type SweepDeps,
  type WorktreeListEntry,
} from './worktree-gc-types.js';
import { isFactoryDirName } from './worktree-name.js';
import { readWorktreeKeeps, releaseWorktreeKeeps, type WorktreeKeep } from './worktree-keeps.js';

export * from './worktree-gc-types.js';
export { findCredentialFiles, scrubFile, zeroFill } from './worktree-gc-scrub.js';
export { countUnpushedCommits, isWorktreeClean, isZeroCommitLane } from './worktree-gc-evidence.js';

/** Removal reasons that prove the work reached the remote — the only ones whose local
 *  branch is safe to force-delete unconditionally. `ttl-expired` fires on age alone and is
 *  excluded: its branch may be the last reachable handle on unpushed commits. The issue-driven
 *  reasons (`issue-closed` / `issue-parked`) are also excluded here — they delete the branch
 *  only when the candidate's per-candidate `branchReapable` flag proved remote evidence at
 *  decision time. See ADR (this PR). */
export const BRANCH_REAPABLE_REASONS: ReadonlySet<GcReason> = new Set<GcReason>(['merged', 'remote-gone']);

/** Where a quarantined worktree lands: `<state>/quarantine/`, matching every other runtime
 *  path's home under the resolved state dir (see `getFactoryPaths`). */
export function quarantineRoot(repoRoot: string): string {
  return join(getFactoryPaths(repoRoot).state, 'quarantine');
}

/** The destination for a quarantined worktree: its own basename under `quarantineDir`, unless
 *  that name is already occupied (e.g. a prior quarantine nobody cleared), in which case a
 *  timestamp suffix disambiguates rather than overwriting or failing. */
export function quarantineDestination(quarantineDir: string, worktreePath: string): string {
  const base = basename(worktreePath);
  const dest = join(quarantineDir, base);
  return existsSync(dest) ? join(quarantineDir, `${base}-${Date.now()}`) : dest;
}

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

/** Dry-run diagnostics, built from the stored evidence in candidate order. The error warns are
 *  logged once per issue. */
function buildDryRunDiagnostics(
  evidences: WorktreeEvidence[],
  log: (type: EventKind, msg: string) => void,
): Pick<GcReport, 'issueNotFound' | 'issueUnverifiable' | 'noActiveClaim'> {
  const issueNotFound: Issue404Candidate[] = [];
  const issueUnverifiable: Issue404Candidate[] = [];
  const noActiveClaim: NoActiveClaimCandidate[] = [];
  const warnedExistence = new Set<number>();
  const warnedClaim = new Set<number>();
  for (const e of evidences) {
    if (e.issue === null) continue;
    if (e.existence === 'not-found') {
      issueNotFound.push({ path: e.path, branch: e.branch, issue: e.issue });
    } else if (e.existence === 'error') {
      issueUnverifiable.push({ path: e.path, branch: e.branch, issue: e.issue });
      if (!warnedExistence.has(e.issue)) {
        warnedExistence.add(e.issue);
        log(
          'warn',
          `worktree-gc: GitHub issue existence check failed for #${e.issue} (${e.issueError}) — reporting as unverifiable`,
        );
      }
    }
  }
  for (const e of evidences) {
    if (e.issue === null || !e.branch) continue;
    if (e.prState !== 'merged' && e.prState !== 'closed') continue;
    if (e.claim === 'unclaimed') {
      noActiveClaim.push({ path: e.path, branch: e.branch, issue: e.issue, prState: e.prState });
    } else if (e.issueError !== undefined && !warnedClaim.has(e.issue)) {
      warnedClaim.add(e.issue);
      log(
        'warn',
        `worktree-gc: GitHub claim-label check failed for #${e.issue} (${e.issueError}) — reporting as unknown (not flagged)`,
      );
    }
  }
  return { issueNotFound, issueUnverifiable, noActiveClaim };
}

export async function sweepWorktrees(
  opts: {
    repoRoot: string;
    ttlDays: number;
    dryRun?: boolean;
    repo?: string;
    branchPrefix?: string;
    /** Issues other lanes of this run have in flight: never reaped, whatever their age or PR state (#2964). */
    protectedIssues?: ReadonlySet<number>;
    /** worktree-keeps.json to honor (#3316); defaults to the repo's state file. */
    keepsFile?: string;
  },
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
  // Slugs are [a-z0-9-] only (branchPrefixSlug), so interpolating them into a regex is safe.
  // Matches the resolved prefix and the legacy ship-it one.
  const lanePattern = new RegExp('^(?:' + factoryBranchPrefixes(opts.branchPrefix).join('|') + ')/(\\d+)-');

  const candidates: WorktreeListEntry[] = entries.filter((entry) => {
    const entryPath = resolve(entry.path);
    if (entryPath === repoRootResolved) return false;
    const base = basename(entryPath);
    if (isFactoryDirName(repoBase, base, entry.branch, opts.branchPrefix)) return true;
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
  const held: GcHeldCandidate[] = [];
  let kept = 0;
  const keepsFile = opts.keepsFile ?? getFactoryPaths(repoRoot).worktreeKeeps;
  const keeps = new Map<number, WorktreeKeep>(readWorktreeKeeps(keepsFile, log).map((k) => [k.issue, k]));
  const keptByRecord: GcKeptCandidate[] = [];
  const releasedKeeps = new Map<string, number>();

  const mainTip = candidates.length > 0 ? await resolveMainTip(runCommand, repoRoot) : null;
  const ctx = createEvidenceContext(
    { repoRoot, repo, dryRun, lanePattern, protectedIssues: opts.protectedIssues, keeps, mainTip },
    { runCommand, now, log, octokit, issueWarnDedup },
  );

  const evidences: WorktreeEvidence[] = [];
  for (const entry of candidates) {
    const evidence = await gatherWorktreeEvidence(ctx, entry);
    evidences.push(evidence);
    const decision = decideWorktree(evidence, { ttlDays, dryRun });
    if (decision.action === 'keep') {
      kept++;
      if (decision.why === 'keep-record' && evidence.keep) {
        keptByRecord.push({
          path: entry.path,
          branch: entry.branch,
          issue: evidence.keep.issue,
          reason: evidence.keep.reason,
        });
      } else if (decision.why === 'held' && evidence.issue !== null) {
        held.push({ path: entry.path, branch: entry.branch, issue: evidence.issue, why: decision.held ?? '' });
      }
      continue;
    }
    if (evidence.keep) releasedKeeps.set(entry.path, evidence.keep.issue);
    removed.push({
      path: entry.path,
      branch: entry.branch,
      ageDays: evidence.ageDays,
      reason: decision.reason,
      scrubbedFiles: [],
      branchDeleted: false,
      branchReapable: decision.branchReapable,
      action: decision.action,
    });
  }

  if (dryRun) {
    const diagnostics = buildDryRunDiagnostics(evidences, log);
    return { removed, kept, dryRun: true, ...diagnostics, held, keptByRecord };
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

    if (candidate.action === 'quarantine') {
      const quarantineDir = quarantineRoot(repoRoot);
      const dest = quarantineDestination(quarantineDir, candidate.path);
      try {
        mkdirSync(quarantineDir, { recursive: true });
        await runCommand(`git worktree move ${shellEscape(candidate.path)} ${shellEscape(dest)}`, { cwd: repoRoot });
        candidate.quarantinedTo = dest;
        log('worktree-gc', `quarantined ${candidate.path} to ${dest} — ${candidate.reason}`);
      } catch (err: any) {
        log(
          'warn',
          `git worktree move failed for ${candidate.path} (${err?.message ?? String(err)}) — falling back to a manual move`,
        );
        try {
          renameSync(candidate.path, dest);
          candidate.quarantinedTo = dest;
          log('worktree-gc', `quarantined ${candidate.path} to ${dest} via manual move — ${candidate.reason}`);
        } catch (renameErr: any) {
          log(
            'warn',
            `manual move fallback failed for ${candidate.path}: ${renameErr?.message ?? String(renameErr)} — worktree left in place`,
          );
        }
      }
      continue;
    }

    try {
      await runCommand(`git worktree remove --force ${shellEscape(candidate.path)}`, { cwd: repoRoot });
      log('worktree-gc', `removed ${candidate.path} — ${candidate.reason}`);
    } catch (err: any) {
      log('warn', `git worktree remove failed for ${candidate.path}: ${err?.message ?? String(err)}`);
      try {
        rmSync(candidate.path, { recursive: true, force: true });
        log('worktree-gc', `removed ${candidate.path} via rmSync fallback — ${candidate.reason}`);
      } catch (rmErr: any) {
        log('warn', `rmSync fallback failed for ${candidate.path}: ${rmErr?.message ?? String(rmErr)}`);
      }
    }
  }

  releaseWorktreeKeeps(keepsFile, releasedKeeps, log);

  await runCommand('git worktree prune', { cwd: repoRoot }).catch((err: any) =>
    log('warn', `git worktree prune failed in ${repoRoot}: ${err?.message ?? String(err)}`),
  );

  await deleteReapedBranches(removed, repoRoot, runCommand, log);

  return {
    removed,
    kept,
    dryRun: false,
    issueNotFound: [],
    issueUnverifiable: [],
    noActiveClaim: [],
    held,
    keptByRecord,
  };
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
    if (candidate.action === 'quarantine') {
      line += candidate.quarantinedTo ? `, quarantined to ${candidate.quarantinedTo}` : ', quarantined';
    }
    lines.push(line);
  }

  const removedCount = report.removed.filter((c) => c.action !== 'quarantine').length;
  const quarantinedCount = report.removed.length - removedCount;
  lines.push(
    quarantinedCount > 0
      ? `${verb} ${removedCount} worktree(s), quarantined ${quarantinedCount}, kept ${report.kept}`
      : `${verb} ${removedCount} worktree(s), kept ${report.kept}`,
  );

  for (const c of report.keptByRecord ?? []) {
    lines.push(`${c.path} (${c.branch ?? 'detached'}) — kept (${c.reason})`);
  }
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

  if (report.held.length > 0) {
    lines.push(`${report.held.length} worktree(s) kept — decomposed parent with local work:`);
    for (const c of report.held) {
      lines.push(`  ${c.path} (${c.branch ?? 'detached'}) — issue #${c.issue}: ${c.why}`);
    }
  }

  return lines.join('\n');
}
