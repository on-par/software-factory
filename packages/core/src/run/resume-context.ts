// packages/core/src/run/resume-context.ts — the resume record runIssue keeps across an
// environment release (#2340). When CHECK releases an issue because every failing checker also
// fails on the base SHA, the frozen spec is still valid; this store remembers which issue body
// it was planned from so the next claim can skip the boss PLAN call when the body is unchanged.
// #2320 (resume at BUILD) extends this same record and store.
// It also builds the #2583 park message for a config-caused CHECK failure.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isConfigCheckerOutput } from '../checkers/index.js';
import { lintFactoryConfig } from '../config/config-lint.js';
import { parseDesignArtifact } from '../design/index.js';
import type { EnvironmentFailure } from '../phases/check.js';
import type { PlanResult } from '../phases/plan.js';
import { readSpec } from '../spec/index.js';
import type { CheckSummary, Constitution } from '../types/index.js';
import { defaultRemoteBase, gitFetch } from '../utils/index.js';
import { execGit } from '../utils/git-exec.js';
import type { BuildRoutePin } from '../config/repo.js';
import type { WorkKey } from '../work/work-key.js';

export interface PlanReuseRecord {
  /** issueBodyHash of the brief the frozen spec was planned from. */
  bodyHash: string;
  /** Base SHA the CHECK environment release was decided on; absent for a rebuild (#3325). */
  baseSha?: string;
  route: BuildRoutePin;
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

export function createPlanReuseStore(specPath: string): PlanReuseStore & {
  /** Records the frozen spec for reuse so a rebuild (#3325) skips PLAN. Throws when there is no frozen spec with a route. */
  recordFrozen(brief: string): Promise<void>;
} {
  const path = planReusePath(specPath);
  const record = async (entry: PlanReuseRecord): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`);
  };
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
    record,
    async clear() {
      await rm(path, { force: true });
    },
    async recordFrozen(brief) {
      const route = await readSpec(specPath).then(
        (spec) => spec.route,
        (err: unknown) => {
          if (isEnoent(err)) return null;
          throw err;
        },
      );
      if (route === null) throw new Error(`no frozen spec with a build route at ${specPath}`);
      await record({ bodyHash: issueBodyHash(brief), route, releasedAt: new Date().toISOString() });
    },
  };
}

/** Where a kept build resumes at CHECK after a config/environment release (#2564). */
export interface CheckResumeRecord {
  issue: WorkKey;
  branch: string;
  /** Absolute path of the kept lane worktree. */
  worktree: string;
  /** build.diffBase from the original run (undefined when BUILD reported none). */
  diffBase?: string;
  /** Base SHA the failing baseline ran on (EnvironmentFailure.baseSha) (#3852). */
  baseSha?: string;
  route: BuildRoutePin;
  /** build.model of the original run, reused as CHECK's reworkModel. */
  model: string;
  /** Whole minutes from PLAN start to BUILD end in the original run, at least 1. */
  buildMinutes: number;
  /** What the user must fix, e.g. `.factory/constitution.md:14`. */
  fixTarget: string;
  preservedAt: string;
}

export interface CheckResumeStore {
  /** ENOENT, malformed JSON or a wrong shape → null. */
  load(): Promise<CheckResumeRecord | null>;
  record(entry: CheckResumeRecord): Promise<void>;
  /** Deletes the record; a missing file is not an error. */
  clear(): Promise<void>;
}

/** The sidecar next to the frozen spec: issue-N.md → issue-N.check-resume.json. */
export function checkResumePath(specPath: string): string {
  return specPath.endsWith('.md') ? `${specPath.slice(0, -3)}.check-resume.json` : `${specPath}.check-resume.json`;
}

export function createCheckResumeStore(specPath: string): CheckResumeStore {
  const path = checkResumePath(specPath);
  return {
    async load() {
      let stored: unknown;
      try {
        stored = JSON.parse(await readFile(path, 'utf-8'));
      } catch (err) {
        if (isEnoent(err) || err instanceof SyntaxError) return null;
        throw err;
      }
      if (typeof stored !== 'object' || stored === null) return null;
      const r = stored as Record<string, unknown>;
      if (
        typeof r.branch !== 'string' ||
        typeof r.worktree !== 'string' ||
        typeof r.route !== 'string' ||
        typeof r.model !== 'string' ||
        typeof r.buildMinutes !== 'number'
      ) {
        return null;
      }
      const record = stored as CheckResumeRecord;
      // Sidecars written before ADR-0168 hold a numeric issue.
      return typeof r.issue === 'number' ? { ...record, issue: String(r.issue) as WorkKey } : record;
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

export function formatPreservedBuildMessage(opts: {
  issue: WorkKey;
  branch: string;
  buildMinutes: number;
  fixTarget: string;
}): string {
  return `${opts.buildMinutes} min of build preserved at ${opts.branch}; fix ${opts.fixTarget} — if the fix lands on the default branch, run factory run-issue ${opts.issue} (resume refuses once the base moves); if it was local to this machine, run factory resume ${opts.issue} --from check`;
}

/** How a kept build's branch relates to the current origin default branch (#3852). */
export type CheckResumeBaseDrift =
  | { kind: 'current'; ref: string; sha: string }
  | { kind: 'moved'; ref: string; from: string; to: string }
  | { kind: 'unknown'; reason: string };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetches origin and checks that the kept branch already contains origin's default branch. */
export async function checkResumeBaseDrift(opts: {
  repoRoot: string;
  record: Pick<CheckResumeRecord, 'worktree' | 'baseSha' | 'diffBase'>;
  fetch?: (repoRoot: string) => Promise<void>;
}): Promise<CheckResumeBaseDrift> {
  const { repoRoot, record, fetch = gitFetch } = opts;
  try {
    await fetch(repoRoot);
  } catch (err) {
    return { kind: 'unknown', reason: `git fetch origin failed: ${errMessage(err)}` };
  }
  let ref: string;
  let to: string;
  try {
    ref = await defaultRemoteBase(repoRoot);
    to = (await execGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: repoRoot })).stdout.trim();
  } catch (err) {
    return { kind: 'unknown', reason: `could not resolve the default branch: ${errMessage(err)}` };
  }
  try {
    await execGit(['merge-base', '--is-ancestor', to, 'HEAD'], { cwd: record.worktree });
    return { kind: 'current', ref, sha: to };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code !== 1) return { kind: 'unknown', reason: `git merge-base failed: ${errMessage(err)}` };
  }
  let from = record.baseSha ?? record.diffBase;
  if (!from) {
    from = await execGit(['merge-base', 'HEAD', to], { cwd: record.worktree }).then(
      (r) => r.stdout.trim() || 'unknown',
      () => 'unknown',
    );
  }
  return { kind: 'moved', ref, from, to };
}

export function formatBaseMovedRefusal(opts: {
  issue: WorkKey;
  drift: Exclude<CheckResumeBaseDrift, { kind: 'current' }>;
}): string {
  const { issue, drift } = opts;
  if (drift.kind === 'moved') {
    return `base moved from ${drift.from} to ${drift.to} (${drift.ref}) since this build was kept — resume --from check would re-check it on the old base; run a fresh build: factory run-issue ${issue}`;
  }
  return `could not verify the kept build's base against origin (${drift.reason}) — nothing was resumed; retry, or run a fresh build: factory run-issue ${issue}`;
}

/** The file:line (or description) the user must fix before resuming CHECK. */
export function preservedFixTarget(
  failure: Pick<EnvironmentFailure, 'cause' | 'failingChecks' | 'logPaths'>,
  constitution: Constitution | null,
  configFile?: { absPath: string; relPath: string },
): string {
  if (failure.cause === 'config') {
    const { findings } = lintFactoryConfig({ constitution, configFile });
    const withLine = findings.find((f) => f.line !== undefined);
    if (withLine) return `${withLine.file}:${withLine.line}`;
    if (findings.length > 0) return findings[0].file;
    if (!constitution) return 'the constitution checkers list';
    const file =
      constitution.repoInstance?.absPath ?? (constitution.source === 'bundled' ? constitution.path : undefined);
    const display = constitution.repoInstance?.relPath ?? constitution.path;
    if (!file) return display;
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf-8').split('\n');
    } catch {
      return display;
    }
    const idx = lines.findIndex((l) => /^\s*checkers\s*:/.test(l));
    return idx >= 0 ? `${display}:${idx + 1}` : display;
  }
  return failure.logPaths?.find((p) => existsSync(p)) ?? `the base (failing: ${failure.failingChecks.join(', ')})`;
}

/** Park message for a config-caused CHECK failure (#2583): file:line, the fix, and how to re-queue. */
export function configParkMessage(opts: {
  issue: WorkKey;
  failure: Pick<EnvironmentFailure, 'cause' | 'failingChecks' | 'logPaths'>;
  summary: CheckSummary;
  constitution: Constitution | null;
  configFile?: { absPath: string; relPath: string };
}): string {
  const { issue, failure, summary, constitution, configFile } = opts;
  const { findings } = lintFactoryConfig({ constitution, configFile });
  const finding = findings.find((f) => f.line !== undefined) ?? findings[0];
  const target =
    finding?.line !== undefined
      ? `${finding.file}:${finding.line}`
      : preservedFixTarget(failure, constitution, configFile);
  let fix: string;
  if (finding) {
    const prefix = `${target}: `;
    fix = finding.message.startsWith(prefix) ? finding.message.slice(prefix.length) : finding.message;
  } else {
    fix =
      summary.results.find((r) => isConfigCheckerOutput(r))?.details ??
      'fix the constitution checkers list so every entry is a known checker name';
  }
  return [
    `config failure in CHECK (${failure.failingChecks.join(', ')}) — parked, not released to queued: it fails the same way on every requeue`,
    `file: ${target}`,
    `fix: ${fix}`,
    `then run factory unpark ${issue}`,
  ].join('\n');
}
