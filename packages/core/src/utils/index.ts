import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Octokit } from '@octokit/rest';
import type { EventKind, FlakyTestsPayload, LanePausedPayload, StewardTriggeredPayload } from '../events/kinds.js';
import type {
  AllProvidersDownPayload,
  ParkPayload,
  ProviderCappedPayload,
  ProviderFailoverPayload,
} from '../events/payloads.js';
import type { RunAttribution } from '../run/outcome.js';
import { createLogger, type LogExtra } from '../logger/index.js';
import type { PrClassificationRecord } from '../review/classifier.js';
import type { PrLookup } from '../phases/ship.js';
import type { WorkKey } from '../work/work-key.js';
import type { EscalateKind } from '../types/index.js';
import type {
  CheckFailureInfo,
  CiFailureEvidence,
  FailoverReason,
  LogLevel,
  ReadinessInfo,
  RemoteBranchRecord,
  ReworkInfo,
} from '../types/index.js';
import { branchPrefixSlug, slugify } from './branch-slug.js';
import { levelForType } from './format.js';
import { execGit } from './git-exec.js';
import { moveLaneBranchAside } from './lane-branch-aside.js';
import { assertLaneReplaceable, laneReapKept, type LaneReapKeptOutcome } from './lane-removal.js';
import { createMicroVm, removeMicroVm, type WorktreeSandbox } from './microvm.js';
import { ensureWorktreeParentExcluded } from './worktree-location.js';

export type { WorktreeSandbox } from './microvm.js';

export { colorEnabled, formatEventLine } from './format.js';

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
    prClassification?: PrClassificationRecord;
    lanePaused?: LanePausedPayload;
    park?: ParkPayload;
    providerCapped?: ProviderCappedPayload;
    providerFailover?: ProviderFailoverPayload;
    allProvidersDown?: AllProvidersDownPayload;
    stewardTriggered?: StewardTriggeredPayload;
    flakyTests?: FlakyTestsPayload;
    checkFailure?: CheckFailureInfo;
    ciFailure?: CiFailureEvidence;
    escalateKind?: EscalateKind;
    actor?: string;
    model?: string;
    tokens?: { input: number; output: number };
    durationMs?: number;
    cpuMs?: number;
    peakRssBytes?: number;
    attribution?: RunAttribution;
    paths?: string[];
    mode?: 'mechanical';
  } & Pick<
    LogExtra,
    'providerAuthRejected' | 'providerBreakerClose' | 'providerRestored' | 'providerRefused' | 'claimLost'
  >,
): void {
  const logger = createLogger(eventsFile, { issue, lane: extra?.lane, phase: extra?.phase });
  const level = extra?.level ?? levelForType(type);
  const meta: Omit<NonNullable<typeof extra>, 'lane' | 'phase' | 'level'> = {};
  if (extra?.failoverReason) meta.failoverReason = extra.failoverReason;
  if (extra?.rework) meta.rework = extra.rework;
  if (extra?.readiness) meta.readiness = extra.readiness;
  if (extra?.prClassification) meta.prClassification = extra.prClassification;
  if (extra?.lanePaused) meta.lanePaused = extra.lanePaused;
  if (extra?.park) meta.park = extra.park;
  if (extra?.providerCapped) meta.providerCapped = extra.providerCapped;
  if (extra?.providerFailover) meta.providerFailover = extra.providerFailover;
  if (extra?.allProvidersDown) meta.allProvidersDown = extra.allProvidersDown;
  if (extra?.providerAuthRejected) meta.providerAuthRejected = extra.providerAuthRejected;
  if (extra?.providerBreakerClose) meta.providerBreakerClose = extra.providerBreakerClose;
  if (extra?.providerRestored) meta.providerRestored = extra.providerRestored;
  if (extra?.claimLost) meta.claimLost = extra.claimLost;
  if (extra?.providerRefused) meta.providerRefused = extra.providerRefused;
  if (extra?.stewardTriggered) meta.stewardTriggered = extra.stewardTriggered;
  if (extra?.flakyTests) meta.flakyTests = extra.flakyTests;
  if (extra?.checkFailure) meta.checkFailure = extra.checkFailure;
  if (extra?.ciFailure) meta.ciFailure = extra.ciFailure;
  if (extra?.escalateKind) meta.escalateKind = extra.escalateKind;
  if (extra?.actor) meta.actor = extra.actor;
  if (extra?.attribution) meta.attribution = extra.attribution;
  if (extra?.model) meta.model = extra.model;
  if (extra?.tokens) meta.tokens = extra.tokens;
  if (extra?.durationMs !== undefined) meta.durationMs = extra.durationMs;
  if (extra?.cpuMs !== undefined) meta.cpuMs = extra.cpuMs;
  if (extra?.peakRssBytes !== undefined) meta.peakRssBytes = extra.peakRssBytes;
  if (extra?.paths) meta.paths = extra.paths;
  if (extra?.mode) meta.mode = extra.mode;
  logger[level](type, msg, Object.keys(meta).length > 0 ? meta : undefined);
}

export { logCost, readCosts } from './cost-log.js';

export async function gitFetch(repoRoot: string): Promise<void> {
  await execGit(['fetch', 'origin', '-q', '--prune'], { cwd: repoRoot });
}

const FALLBACK_REMOTE_BASE = 'origin/main';

export async function defaultRemoteBase(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execGit(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { cwd: repoRoot });
    const m = stdout.trim().match(/^refs\/remotes\/(origin\/.+)$/);
    if (m) return m[1];
  } catch {
    return FALLBACK_REMOTE_BASE;
  }
  return FALLBACK_REMOTE_BASE;
}

export async function detectRemoteBranch(repoRoot: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`], {
      cwd: repoRoot,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface WorktreeSetupOptions {
  findOpenPr?: (branch: string) => Promise<PrLookup>;
  keepsFile?: string;
  issue?: number;
  now?: () => Date;
}

export interface WorktreeSetupResult {
  base: string;
  head: string;
  remoteBranch: RemoteBranchRecord | null;
}

export async function setupWorktree(
  repoRoot: string,
  branch: string,
  worktreePath: string,
  startPoint?: string,
  sandbox?: WorktreeSandbox,
  log?: (type: EventKind, msg: string) => void,
  opts?: WorktreeSetupOptions,
): Promise<WorktreeSetupResult> {
  await gitFetch(repoRoot);
  if (startPoint) {
    try {
      await execGit(['rev-parse', '--verify', '-q', `${startPoint}^{commit}`], { cwd: repoRoot });
    } catch {
      throw new Error(
        `base ref ${startPoint} does not resolve after git fetch origin — check the branch exists on origin`,
      );
    }
  }
  let openPrBranch = false;
  let remoteBranch: RemoteBranchRecord | null = null;
  let prStatus: PrLookup['status'] | null = null;
  const remoteSha = await detectRemoteBranch(repoRoot, branch);
  if (remoteSha) {
    remoteBranch = { sha: remoteSha };
    let prText = 'open PR not checked';
    if (opts?.findOpenPr) {
      let lookup: PrLookup;
      try {
        lookup = await opts.findOpenPr(branch);
      } catch (err) {
        lookup = { status: 'error', detail: err instanceof Error ? err.message : String(err) };
      }
      prStatus = lookup.status;
      if (lookup.status === 'found') {
        remoteBranch.prNumber = lookup.prNumber;
        openPrBranch = true;
        prText = startPoint
          ? `open PR #${lookup.prNumber}`
          : `open PR #${lookup.prNumber} — continuing on origin/${branch}`;
      } else if (lookup.status === 'absent') {
        prText = 'no open PR';
      } else {
        prText = `open PR lookup failed: ${lookup.detail}`;
      }
    }
    log?.('remote-branch-preexisting', `origin/${branch} already exists @ ${remoteSha}; ${prText}`);
  }
  const base = startPoint ?? (openPrBranch ? `origin/${branch}` : await defaultRemoteBase(repoRoot));
  await assertLaneReplaceable(repoRoot, branch, worktreePath, opts, log ?? (() => {}));
  await execGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot }).catch(() => {});
  await execGit(['branch', '-D', branch], { cwd: repoRoot }).catch(() => {});
  const stuck = await execGit(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: repoRoot }).then(
    () => true,
    () => false,
  );
  if (stuck)
    await moveLaneBranchAside(repoRoot, branch, { remoteSha, prStatus, now: opts?.now, log: log ?? (() => {}) });
  mkdirSync(dirname(worktreePath), { recursive: true });
  await ensureWorktreeParentExcluded(repoRoot, dirname(worktreePath));
  await execGit(['worktree', 'add', '-b', branch, worktreePath, base], { cwd: repoRoot });
  const { stdout } = await execGit(['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath });
  log?.('worktree-base', `created from ${base} @ ${stdout.trim()}`);
  if (sandbox) {
    await createMicroVm({ ...sandbox, worktreePath, log });
  }
  return { base, head: stdout.trim(), remoteBranch };
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
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  const listed = await execGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot }).catch(() => null);
  const linked =
    !listed ||
    [...listed.stdout.matchAll(/^worktree (.+)$/gm)].slice(1).some((m) => real(m[1]!) === real(worktreePath));
  const git = (args: string[], what: string) =>
    execGit(args, { cwd: repoRoot }).catch((err: any) =>
      log('warn', `git worktree ${what}: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`),
    );
  if (linked) await git(['worktree', 'remove', '--force', worktreePath], `remove failed for ${worktreePath}`);
  await git(['worktree', 'prune'], `prune failed in ${repoRoot}`);
}

export interface LaneWorktreeReapResult {
  outcome: 'removed' | LaneReapKeptOutcome | 'kept-committed' | 'kept-branch-mismatch' | 'absent';
  branch: string | null;
  branchDeleted: boolean;
}

export async function reapLaneWorktree(
  repoRoot: string,
  worktreePath: string,
  opts: {
    issue: number;
    branchPrefix?: string;
    log?: (type: EventKind, msg: string) => void;
    sandbox?: WorktreeSandbox;
    keepsFile?: string;
  },
): Promise<LaneWorktreeReapResult> {
  const log = opts.log ?? (() => {});
  if (!existsSync(worktreePath)) {
    return { outcome: 'absent', branch: null, branchDeleted: false };
  }

  const lanePrefix = `${branchPrefixSlug(opts.branchPrefix)}/${opts.issue}-`;
  const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }).then(
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

  const kept = await laneReapKept(repoRoot, worktreePath, opts, log);
  if (kept) return { outcome: kept, branch, branchDeleted: false };

  const tip = await execGit(['rev-parse', 'HEAD'], { cwd: worktreePath }).then(
    (r) => r.stdout.trim(),
    () => null,
  );

  await cleanupWorktree(repoRoot, worktreePath, log, opts.sandbox);

  const lsRemote = await execGit(['ls-remote', '--heads', 'origin', branch], { cwd: repoRoot }).catch(() => null);
  const onRemote =
    (lsRemote !== null && lsRemote.stdout.trim() !== '') ||
    (tip !== null &&
      (await execGit(['merge-base', '--is-ancestor', tip, 'origin/main'], { cwd: repoRoot }).then(
        () => true,
        () => false,
      )));

  let branchDeleted = false;
  if (onRemote) {
    try {
      await execGit(['branch', '-D', branch], { cwd: repoRoot });
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

export async function reapCleanShipWorktree(
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
  const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  if (branch === null) {
    log('warn', `could not read the checked-out branch of ${worktreePath} — kept`);
    return { outcome: 'kept-unverified', branch: null, branchDeleted: false };
  }
  if (!branch.startsWith(lanePrefix)) {
    log('warn', `worktree at ${worktreePath} is on '${branch}', not a ${lanePrefix}* lane branch — leaving it alone`);
    return { outcome: 'kept-branch-mismatch', branch, branchDeleted: false };
  }

  const status = await execGit(['status', '--porcelain'], { cwd: worktreePath }).catch(() => null);
  if (status === null) {
    log('warn', `could not verify ${worktreePath} is clean (git status failed) — kept`);
    return { outcome: 'kept-unverified', branch, branchDeleted: false };
  }
  if (status.stdout.trim() !== '') {
    log('worktree-gc', `kept worktree ${worktreePath} — it has uncommitted changes`);
    return { outcome: 'kept-dirty', branch, branchDeleted: false };
  }

  const base = await defaultRemoteBase(repoRoot);
  const ahead = await execGit(['rev-list', '--count', `${base}..HEAD`], { cwd: worktreePath }).then(
    (r) => Number.parseInt(r.stdout.trim(), 10),
    () => Number.NaN,
  );
  if (Number.isNaN(ahead)) {
    log('warn', `could not count commits beyond ${base} in ${worktreePath} — kept`);
    return { outcome: 'kept-unverified', branch, branchDeleted: false };
  }
  if (ahead !== 0) {
    log('worktree-gc', `kept worktree ${worktreePath} and branch ${branch} — it has commits beyond ${base}`);
    return { outcome: 'kept-committed', branch, branchDeleted: false };
  }

  await cleanupWorktree(repoRoot, worktreePath, log, opts.sandbox);

  let branchDeleted = false;
  try {
    await execGit(['branch', '-D', branch], { cwd: repoRoot });
    branchDeleted = true;
  } catch (err: any) {
    log(
      'warn',
      `git branch -D failed for ${branch}: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`,
    );
  }

  log(
    'worktree-gc',
    `removed PR-less ship worktree ${worktreePath} for issue #${opts.issue}${branchDeleted ? `, deleted branch ${branch}` : ''}`,
  );
  return { outcome: 'removed', branch, branchDeleted };
}

export { branchPrefixSlug, slugify };

export function factoryBranchPrefixes(prefix?: string): string[] {
  return [branchPrefixSlug(prefix)];
}

export function factoryBranchIssue(branch: string, prefix?: string): number | null {
  for (const p of factoryBranchPrefixes(prefix)) {
    const match = new RegExp(`^${p}/(\\d+)-`).exec(branch);
    if (match) return Number(match[1]);
  }
  return null;
}

export function branchFor(key: WorkKey, title: string, prefix?: string, slice?: number): string {
  if (slice !== undefined && slice >= 2) return `${branchPrefixSlug(prefix)}/${key}-s${slice}-${slugify(title)}`;
  return `${branchPrefixSlug(prefix)}/${key}-${slugify(title)}`;
}

export async function getIssueTitle(repo: string, issue: number, octokit: Pick<Octokit, 'rest'>): Promise<string> {
  const [owner, repoName] = repo.split('/');
  const { data } = await octokit.rest.issues.get({
    owner,
    repo: repoName,
    issue_number: issue,
  });
  return data.title;
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export { escalationLine, isEscalation } from './escalation.js';
