// src/run/lane-file-guard.ts — Same-file lane guard (#1515): a file-backed registry of
// each in-flight run's PLAN-reported touched files, mirroring ProviderBreaker's
// (router/breaker.ts) constructor(file) + read/write-tmp-and-rename shape so it works
// across concurrent lane processes within one `factory run` invocation the same way the
// breaker already does. Parks the second lane to claim an already-owned file, rather than
// letting two lanes' BUILD phases race to write conflicting diffs to the same path.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { CLAIM_EXPIRES_LABEL_PREFIX, IN_PROGRESS_LABEL } from '../queue/github-queue.js';
import { findStaleClaims } from '../queue/stale-claims.js';
import type { DesignArtifact } from '../types/index.js';
import { branchFor } from '../utils/index.js';

export interface LaneFileClaim {
  repo: string;
  issue: number;
  files: string[];
  claimedAt: string;
}

interface LaneFileGuardFile {
  version: 1;
  claims: Record<string, LaneFileClaim>;
}

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

export type LaneClaimStaleReason = 'issue-closed' | 'pr-merged' | 'pr-closed';

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
    data.claims[runKeyFor(repo, issue)] = { repo, issue, files, claimedAt: new Date().toISOString() };
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

  private async read(): Promise<LaneFileGuardFile> {
    try {
      const raw = await readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<LaneFileGuardFile>;
      return { version: 1, claims: parsed.claims ?? {} };
    } catch {
      return { version: 1, claims: {} };
    }
  }

  private async write(data: LaneFileGuardFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, this.file);
  }
}

/** GitHub-backed staleness probe (#3063). Fails safe: any lookup error, a live holder
 *  (in-progress label or unexpired lease), an open PR, or no PR found all return undefined. */
export function createGithubLaneClaimStalenessProbe(opts: {
  octokit: Pick<Octokit, 'rest'>;
  branchPrefix?: string;
  now?: () => number;
}): LaneClaimStalenessProbe {
  const { octokit, branchPrefix, now } = opts;
  return async (claim) => {
    try {
      const [owner, repoName] = claim.repo.split('/');
      const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: claim.issue });
      if (data.state === 'closed') return 'issue-closed';
      const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : (l?.name ?? '')));
      if (labels.includes(IN_PROGRESS_LABEL)) return undefined;
      if (
        labels.some((l) => l.startsWith(CLAIM_EXPIRES_LABEL_PREFIX)) &&
        findStaleClaims([{ number: claim.issue, labels }], { now }).length === 0
      ) {
        return undefined;
      }
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
      return prs.length > 0 ? 'pr-closed' : undefined;
    } catch {
      return undefined;
    }
  };
}
