import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { defaultIsPidAlive } from '../environment/index.js';
import type { EventKind } from '../events/kinds.js';
import { claimIsLive, claimLiveness } from '../queue/claim-liveness.js';
import type { DesignArtifact } from '../types/index.js';
import { branchFor } from '../utils/index.js';
import { issueNumberOf, type WorkKey } from '../work/work-key.js';
import type { BuildRoute, RunOutcome } from './outcome.js';

export interface LaneFileClaim {
  repo: string;
  issue: WorkKey;
  files: string[];
  claimedAt: string;
  pid?: number;
}

export interface LaneFileHold {
  repo: string;
  issue: WorkKey;
  holder: WorkKey;
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
  issue: WorkKey;
  file: string;
}

export function touchedFilesFrom(design: Pick<DesignArtifact, 'targetTypes' | 'signatures'>): string[] {
  const files = new Set<string>();
  for (const t of design.targetTypes) {
    if (t.kind !== 'read') files.add(t.file);
  }
  for (const s of design.signatures) files.add(s.file);
  return [...files];
}

export type LaneClaimStaleReason = 'issue-closed' | 'pr-merged' | 'pr-closed' | 'holder-not-running';

export type LaneClaimStalenessProbe = (claim: LaneFileClaim) => Promise<LaneClaimStaleReason | undefined>;

export interface FindCollisionOptions {
  isStale?: LaneClaimStalenessProbe;
  log?: (type: EventKind, msg: string) => void;
}

export interface SweepStaleOptions {
  isStale: LaneClaimStalenessProbe;
  repo?: string;
  log?: (type: EventKind, msg: string) => void;
}

export interface LaneClaimReap {
  claim: LaneFileClaim;
  reason: LaneClaimStaleReason;
}

function runKeyFor(repo: string, issue: WorkKey): string {
  return `${repo}#${issue}`;
}

export class LaneFileGuard {
  constructor(private file: string) {}

  async register(repo: string, issue: WorkKey, files: string[]): Promise<void> {
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

  async release(repo: string, issue: WorkKey): Promise<void> {
    const data = await this.read();
    const key = runKeyFor(repo, issue);
    if (!(key in data.claims)) return;
    delete data.claims[key];
    await this.write(data);
  }

  async recordHold(repo: string, issue: WorkKey, collision: LaneFileCollision): Promise<void> {
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

  async liveHold(repo: string, issue: WorkKey): Promise<LaneFileHold | undefined> {
    const data = await this.read();
    const key = runKeyFor(repo, issue);
    const hold = data.holds[key];
    if (!hold) return undefined;
    if (data.claims[runKeyFor(hold.repo, hold.holder)]?.files.includes(hold.file)) return hold;
    delete data.holds[key];
    await this.write(data);
    return undefined;
  }

  async claimsForIssue(issue: WorkKey): Promise<LaneFileClaim[]> {
    const data = await this.read();
    return Object.values(data.claims).filter((c) => c.issue === issue);
  }

  async releaseIssue(issue: WorkKey): Promise<boolean> {
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

  async findCollision(
    repo: string,
    issue: WorkKey,
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
      const claims = Object.fromEntries(
        Object.entries(parsed.claims ?? {}).map(([k, c]) => [k, { ...c, issue: String(c.issue) as WorkKey }]),
      );
      const holds = Object.fromEntries(
        Object.entries(parsed.holds ?? {}).map(([k, h]) => [
          k,
          { ...h, issue: String(h.issue) as WorkKey, holder: String(h.holder) as WorkKey },
        ]),
      );
      return { version: 1, claims, holds };
    } catch {
      return { version: 1, claims: {}, holds: {} };
    }
  }

  private async write(data: LaneFileGuardFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

export async function deferOnLaneCollision(
  guard: LaneFileGuard,
  request: { repo: string; issue: WorkKey; branch: string },
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
    holder: issueNumberOf(collision.issue),
    file: collision.file,
    route,
    branch,
    reworkRounds: 0,
  };
}

export async function releaseLaneClaim(
  guard: LaneFileGuard,
  repo: string,
  issue: WorkKey,
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
      const { data } = await octokit.rest.issues.get({
        owner,
        repo: repoName,
        issue_number: issueNumberOf(claim.issue),
      });
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

function holderRunning(pid: unknown, isPidAlive: (pid: number) => boolean): boolean {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && isPidAlive(pid);
}
