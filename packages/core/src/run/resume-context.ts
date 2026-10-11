// packages/core/src/run/resume-context.ts — the resume record runIssue keeps across an
// environment release (#2340). When CHECK releases an issue because every failing checker also
// fails on the base SHA, the frozen spec is still valid; this store remembers which issue body
// it was planned from so the next claim can skip the boss PLAN call when the body is unchanged.
// #2320 (resume at BUILD) extends this same record and store.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseDesignArtifact } from '../design/index.js';
import type { PlanResult } from '../phases/plan.js';
import { readSpec } from '../spec/index.js';

export interface PlanReuseRecord {
  /** issueBodyHash of the brief the frozen spec was planned from. */
  bodyHash: string;
  /** Base SHA the CHECK environment release was decided on. */
  baseSha: string;
  route: 'codex' | 'claude' | 'opencode';
  releasedAt: string;
}

export interface PlanReuseStore {
  /** A PlanResult rebuilt from the frozen spec when the record matches bodyHash, else null. Never deletes. */
  load(bodyHash: string): Promise<PlanResult | null>;
  record(entry: PlanReuseRecord): Promise<void>;
  /** Deletes the record; a missing file is not an error. */
  clear(): Promise<void>;
}

/** sha256 hex of the brief, insensitive to CRLF and outer whitespace. */
export function issueBodyHash(brief: string): string {
  return createHash('sha256').update(brief.replace(/\r\n/g, '\n').trim()).digest('hex');
}

/** The sidecar next to the frozen spec: issue-N.md → issue-N.resume.json. */
export function planReusePath(specPath: string): string {
  return specPath.endsWith('.md') ? `${specPath.slice(0, -3)}.resume.json` : `${specPath}.resume.json`;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export function createPlanReuseStore(specPath: string): PlanReuseStore {
  const path = planReusePath(specPath);
  return {
    async load(bodyHash) {
      let stored: unknown;
      try {
        stored = JSON.parse(await readFile(path, 'utf-8'));
      } catch (err) {
        if (isEnoent(err) || err instanceof SyntaxError) return null;
        throw err;
      }
      if (typeof stored !== 'object' || stored === null || (stored as { bodyHash?: unknown }).bodyHash !== bodyHash) {
        return null;
      }
      let spec;
      try {
        spec = await readSpec(specPath);
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
      if (spec.route === null) return null;
      const { artifact } = parseDesignArtifact(spec.data);
      return { ok: true, route: spec.route, specPath, model: 'plan-reused', designArtifact: artifact };
    },
    async record(entry) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}
