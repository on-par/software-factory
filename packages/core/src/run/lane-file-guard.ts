// src/run/lane-file-guard.ts — Same-file lane guard (#1515): a file-backed registry of
// each in-flight run's PLAN-reported touched files, mirroring ProviderBreaker's
// (router/breaker.ts) constructor(file) + read/write-tmp-and-rename shape so it works
// across concurrent lane processes within one `factory run` invocation the same way the
// breaker already does. Parks the second lane to claim an already-owned file, rather than
// letting two lanes' BUILD phases race to write conflicting diffs to the same path.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { DesignArtifact } from '../types/index.js';

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

  /** Checks `files` against every other repo-scoped claim (the caller's own repo+issue is
   *  excluded, so a re-check never collides with itself). Cross-repo claims never collide —
   *  single-repo scope, by design. Returns the first colliding issue/file pair, if any. */
  async findCollision(repo: string, issue: number, files: string[]): Promise<LaneFileCollision | undefined> {
    if (files.length === 0) return undefined;
    const data = await this.read();
    const wanted = new Set(files);
    for (const claim of Object.values(data.claims)) {
      if (claim.repo !== repo || claim.issue === issue) continue;
      for (const f of claim.files) {
        if (wanted.has(f)) return { issue: claim.issue, file: f };
      }
    }
    return undefined;
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
