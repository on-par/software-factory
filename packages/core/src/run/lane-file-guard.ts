// src/run/lane-file-guard.ts — Same-file lane guard (#1515): a file-backed registry of
// each in-flight run's PLAN-reported touched files, mirroring ProviderBreaker's
// (router/breaker.ts) constructor(file) + read/write-tmp-and-rename shape so it works
// across concurrent lane processes within one `factory run` invocation the same way the
// breaker already does. Defers the second lane to claim an already-owned file (#3576: re-queues it
// with a recorded hold, never parks it), rather than
// letting two lanes' BUILD phases race to write conflicting diffs to the same path.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { defaultIsPidAlive } from '../environment/index.js';
import type { EventKind } from '../events/kinds.js';
import { claimIsLive, claimLiveness } from '../queue/claim-liveness.js';
import type { DesignArtifact } from '../types/index.js';
import { branchFor } from '../utils/index.js';
import type { BuildRoute, RunOutcome } from './outcome.js';

export interface LaneFileClaim {
  repo: string;
  issue: number;
  files: string[];
  claimedAt: string;
  /** pid of the process that registered the claim (#1618). Absent on claims written before it. */
  pid?: number;
}

/** #3576: a deferred issue waiting for `holder` to release `file`. */
export interface LaneFileHold {
  repo: string;
  issue: number;
  holder: number;
  file: string;
  heldAt: string;
}

interface LaneFileGuardFile {
  version: 1;
  claims: Record<string, LaneFileClaim>;
  holds?: Record<string, LaneFileHold>;
}

type ReadLaneFileGuardFile = LaneFileGuardFile & { holds: Record<string, LaneFileHold> };

export interface LaneFileCollision {
  issue: number;
  file: string;
}

/** The run's touched-files set, from the two DesignArtifact fields PLAN's own prompt
 *  requires to be real, checkout-relative paths — never the free-text `interfacesTouched`
 *  field, which PLAN can and does fill with bare symbol names. A `targetTypes` entry with
 *  `kind: 'read'` is excluded: a target a plan only reads can't produce a conflicting diff. */
export function touchedFilesFrom(design: Pick<DesignArtifact, 'targetTypes' | 'signatures'>): string[] {
  const files = new Set<string>();
  for (const t of design.targetTypes) {
    if (t.kind !== 'read') files.add(t.file);
  }
  for (const s of design.signatures) files.add(s.file);
  return [...files];
}

export type LaneClaimStaleReason = 'issue-closed' | 'pr-merged' | 'pr-closed' | 'holder-not-running';

/** Resolves why `claim`'s holder is finished, or undefined when it is (or may be) live. Must
 *  never throw for a lookup failure — return undefined so the claim keeps blocking. */
export type LaneClaimStalenessProbe = (claim: LaneFileClaim) => Promise<LaneClaimStaleReason | undefined>;

export interface FindCollisionOptions {
  isStale?: LaneClaimStalenessProbe;
  log?: (type: EventKind, msg: string) => void;
}

export interface SweepStaleOptions {
  isStale: LaneClaimStalenessProbe;
  /** Only sweep claims in this repo (owner/name). Omitted = every claim. */
  repo?: string;
  log?: (type: EventKind, msg: string) => void;
}

export interface LaneClaimReap {
  claim: LaneFileClaim;
  reason: LaneClaimStaleReason;
}

function runKeyFor(repo: string, issue: number): string {
  return `${repo}#${issue}`;
}

export class LaneFileGuard {
  constructor(private file: string) {}

  /** Upsert this run's claim (no-op for an empty file set — nothing to guard). */
  async register(repo: string, issue: number, files: string[]): Promise<void> {
    if (files.length === 0) return;
    const data = await this.read();
    delete data.holds[runKeyFor(repo, issue)];
    data.claims[runKeyFor(repo, issue)] = {
      repo,
      issue,
      files,
      claimedAt: new Date().toISOString(),
      pid: process.pid,
    };
    await this.write(data);
  }

  /** Removes this run's claim, if any. Safe to call on a repo+issue with no claim. */
  async release(repo: string, issue: number): Promise<void> {
    const data = await this.read();
    const key = runKeyFor(repo, issue);
    if (!(key in data.claims)) return;
    delete data.claims[key];
    await this.write(data);
  }

  /** Records that `issue` was deferred behind `collision.issue`'s claim on `collision.file` (#3576). */
  async recordHold(repo: string, issue: number, collision: LaneFileCollision): Promise<void> {
    const data = await this.read();
    data.holds[runKeyFor(repo, issue)] = {
      repo,
      issue,
      holder: collision.issue,
      file: collision.file,
      heldAt: new Date().toISOString(),
    };
    await this.write(data);
  }

  /** The hold for `issue` while the holder's claim still lists the held file. A hold whose
   *  holder claim is gone (released, parked, reaped) or no longer lists the file is deleted. */
  async liveHold(repo: string, issue: number): Promise<LaneFileHold | undefined> {
    const data = await this.read();
    const key = runKeyFor(repo, issue);
    const hold = data.holds[key];
    if (!hold) return undefined;
    if (data.claims[runKeyFor(hold.repo, hold.holder)]?.files.includes(hold.file)) return hold;
    delete data.holds[key];
    await this.write(data);
    return undefined;
  }

  /** Every claim for `issue`, whatever its repo. Read-only — for `factory reset --dry-run`. */
  async claimsForIssue(issue: number): Promise<LaneFileClaim[]> {
    const data = await this.read();
    return Object.values(data.claims).filter((c) => c.issue === issue);
  }

  /** Removes every claim for `issue`, whatever its repo. For `factory reset`, which may not
   *  know the gh repo slug. Resolves true when any claim was removed. */
  async releaseIssue(issue: number): Promise<boolean> {
    const data = await this.read();
    let removed = false;
    for (const [key, claim] of Object.entries(data.claims)) {
      if (claim.issue !== issue) continue;
      delete data.claims[key];
      removed = true;
    }
    for (const [key, hold] of Object.entries(data.holds)) {
      if (hold.issue !== issue) continue;
      delete data.holds[key];
      removed = true;
    }
    if (removed) await this.write(data);
    return removed;
  }

  /** Checks `files` against every other repo-scoped claim (the caller's own repo+issue is
   *  excluded, so a re-check never collides with itself). Cross-repo claims never collide —
   *  single-repo scope, by design. Returns the first colliding issue/file pair, if any.
   *  With `opts.isStale` (#3063), an overlapping claim whose holder is provably finished is
   *  removed (and logged as `lane_file_claim_reaped`) and the scan continues; an undefined
   *  verdict, or a throwing probe, keeps the claim blocking. */
  async findCollision(
    repo: string,
    issue: number,
    files: string[],
    opts: FindCollisionOptions = {},
  ): Promise<LaneFileCollision | undefined> {
    if (files.length === 0) return undefined;
    const data = await this.read();
    const wanted = new Set(files);
    const reaped: Array<{ key: string; claim: LaneFileClaim; reason: LaneClaimStaleReason }> = [];
    let collision: LaneFileCollision | undefined;
    for (const [key, claim] of Object.entries(data.claims)) {
      if (claim.repo !== repo || claim.issue === issue) continue;
      const file = claim.files.find((f) => wanted.has(f));
      if (file === undefined) continue;
      let reason: LaneClaimStaleReason | undefined;
      if (opts.isStale) {
        try {
          reason = await opts.isStale(claim);
        } catch {
          reason = undefined;
        }
      }
      if (reason === undefined) {
        collision = { issue: claim.issue, file };
        break;
      }
      reaped.push({ key, claim, reason });
    }
    if (reaped.length > 0) await this.reap(reaped, opts.log);
    return collision;
  }

  /** Proactive stale-claim sweep (#3065): probes every claim (scoped to opts.repo when set)
   *  and releases the ones whose holder is provably finished, logging each as
   *  `lane_file_claim_reaped`. An undefined verdict or a throwing probe keeps the claim. */
  async sweepStale(opts: SweepStaleOptions): Promise<LaneClaimReap[]> {
    const data = await this.read();
    const stale: Array<{ key: string; claim: LaneFileClaim; reason: LaneClaimStaleReason }> = [];
    for (const [key, claim] of Object.entries(data.claims)) {
      if (opts.repo !== undefined && claim.repo !== opts.repo) continue;
      let reason: LaneClaimStaleReason | undefined;
      try {
        reason = await opts.isStale(claim);
      } catch {
        reason = undefined;
      }
      if (reason !== undefined) stale.push({ key, claim, reason });
    }
    if (stale.length === 0) return [];
    return this.reap(stale, opts.log);
  }

  /** Drops probed-stale claims, skipping any whose holder re-registered since the probe. */
  private async reap(
    reaped: Array<{ key: string; claim: LaneFileClaim; reason: LaneClaimStaleReason }>,
    log: FindCollisionOptions['log'],
  ): Promise<LaneClaimReap[]> {
    const data = await this.read();
    const removed: typeof reaped = [];
    for (const entry of reaped) {
      if (data.claims[entry.key]?.claimedAt !== entry.claim.claimedAt) continue;
      delete data.claims[entry.key];
      removed.push(entry);
    }
    if (removed.length === 0) return [];
    await this.write(data);
    for (const { claim, reason } of removed) {
      log?.(
        'lane_file_claim_reaped',
        `lane file claim reaped: #${claim.issue} (${reason}) released ${claim.files.join(', ')} in ${claim.repo}`,
      );
    }
    return removed.map(({ claim, reason }) => ({ claim, reason }));
  }

  private async read(): Promise<ReadLaneFileGuardFile> {
    try {
      const raw = await readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<LaneFileGuardFile>;
      return { version: 1, claims: parsed.claims ?? {}, holds: parsed.holds ?? {} };
    } catch {
      return { version: 1, claims: {}, holds: {} };
    }
  }

  private async write(data: LaneFileGuardFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, this.file);
  }
}

/** #3576: defer `issue` behind a live same-file collision. Records the hold best-effort (a
 *  failed write is logged and the run still defers), logs `issue_deferred`, and returns the
 *  released outcome — no park comment, no `factory:parked`. */
export async function deferOnLaneCollision(
  guard: LaneFileGuard,
  request: { repo: string; issue: number; branch: string },
  collision: LaneFileCollision,
  route: BuildRoute | undefined,
  log: (type: EventKind, msg: string) => void,
): Promise<Extract<RunOutcome, { reason: 'file-overlap' }>> {
  const { repo, issue, branch } = request;
  try {
    await guard.recordHold(repo, issue, collision);
  } catch (err) {
    log(
      'environment_warning',
      `could not record lane-file hold for #${issue}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log(
    'issue_deferred',
    `issue deferred: #${issue} touches ${collision.file}, already claimed by in-flight issue #${collision.issue} — re-queued until that lane finishes`,
  );
  return {
    state: 'released',
    reason: 'file-overlap',
    holder: collision.issue,
    file: collision.file,
    route,
    branch,
    reworkRounds: 0,
  };
}

/** Best-effort claim release (#3067): a failing lane-files.json write is logged as
 *  `lane_file_release_failed` and the claim stays recorded; never throws. */
export async function releaseLaneClaim(
  guard: LaneFileGuard,
  repo: string,
  issue: number,
  log: (type: EventKind, msg: string) => void,
): Promise<boolean> {
  try {
    await guard.release(repo, issue);
    return true;
  } catch (err) {
    log(
      'lane_file_release_failed',
      `lane file claim release failed for #${issue} in ${repo}: ${err instanceof Error ? err.message : String(err)} — claim kept in lane-files.json`,
    );
    return false;
  }
}

/** GitHub-backed staleness probe (#3063). Fails safe: any lookup error, a live holder
 *  (claimLiveness says live or no-lease (#3442), an open PR, or a live recorded pid) or any lookup
 *  error returns undefined. No PR plus an absent or dead pid returns 'holder-not-running' (#1618). */
export function createGithubLaneClaimStalenessProbe(opts: {
  octokit: Pick<Octokit, 'rest'>;
  branchPrefix?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}): LaneClaimStalenessProbe {
  const { octokit, branchPrefix, now, isPidAlive = defaultIsPidAlive } = opts;
  return async (claim) => {
    try {
      const [owner, repoName] = claim.repo.split('/');
      const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: claim.issue });
      if (data.state === 'closed') return 'issue-closed';
      const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : (l?.name ?? '')));
      if (claimIsLive(claimLiveness(labels, (now ?? Date.now)()))) return undefined;
      const branch = branchFor(claim.issue, data.title, branchPrefix);
      const { data: prs } = await octokit.rest.pulls.list({
        owner,
        repo: repoName,
        state: 'all',
        head: `${owner}:${branch}`,
        per_page: 100,
      });
      if (prs.some((pr) => pr.state === 'open')) return undefined;
      if (prs.some((pr) => pr.merged_at)) return 'pr-merged';
      if (prs.length > 0) return 'pr-closed';
      return holderRunning(claim.pid, isPidAlive) ? undefined : 'holder-not-running';
    } catch {
      return undefined;
    }
  };
}

/** True only for a valid positive-integer pid that is alive on this host; an absent or
 *  malformed pid is never passed to process.kill (0/negatives target process groups). */
function holderRunning(pid: unknown, isPidAlive: (pid: number) => boolean): boolean {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && isPidAlive(pid);
}
