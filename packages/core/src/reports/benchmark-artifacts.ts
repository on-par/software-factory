// packages/core/src/reports/benchmark-artifacts.ts — versioned benchmark artifact
// manifest for opt-in local-only runs (#509).
import { exec as execCb } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { CheckSummary, CostEntry, FactoryEvent, FailurePhase } from '../types/index.js';
import { readCosts } from '../utils/index.js';
import type { WorkRequest } from '../work/index.js';
import { parseModelAttempts, readIssueEvents } from './local-run.js';

const exec = promisify(execCb);
type ReportRun = (
  command: string,
  opts: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Bump when the manifest schema changes in a way #510 needs to detect. */
export const BENCHMARK_MANIFEST_VERSION = 1;

export class InvalidArtifactsDirError extends Error {
  constructor(detail: string) {
    super(`invalid artifacts directory: ${detail}`);
    this.name = 'InvalidArtifactsDirError';
  }
}

/** Validate/create a caller-provided artifact directory. Throws BEFORE any
 *  pipeline work can begin. */
export function resolveArtifactsDir(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new InvalidArtifactsDirError('artifacts path must be a non-empty string');
  }
  const dir = resolve(raw);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    stat = undefined;
  }
  if (stat) {
    if (!stat.isDirectory()) {
      throw new InvalidArtifactsDirError(`${dir} is not a directory`);
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err: any) {
      throw new InvalidArtifactsDirError(`could not create ${dir}: ${err.message}`);
    }
  }
  return dir;
}

/** Typed failure captured when a local-only run does not reach a passing CHECK. */
export interface BenchmarkRunFailure {
  /** Pipeline phase the run terminated in. */
  phase: FailurePhase;
  /** Park classification from parkReasonFor: 'fail' | 'escalate' | 'timeout' | 'conflict'. */
  reason: string;
  message: string;
}

export interface BenchmarkModelAttempt {
  model: string;
  task: string;
  attempt: string;
  /** FailoverReason text when the router abandoned this model. */
  reason?: string;
}

export interface BenchmarkManifest {
  manifestVersion: number;
  run: {
    issue: number;
    profile: 'local-only';
    outcome: 'ready' | 'failed' | 'parked' | 'escalated';
    startedAt: string;
    endedAt: string;
    elapsedMs: number;
    workspace: string;
    branch?: string;
    specPath?: string;
    route?: string;
  };
  /** Resolved request metadata from the canonical work-request seam. */
  request?: WorkRequest;
  /** Per-phase outcome: 'ok' | 'failed' | 'skipped'. SHIP is always 'skipped' in local-only. */
  phases: { plan: string; build: string; check: string; ship: 'skipped' };
  /** Model selection + routing/failover attempts parsed from run events. */
  modelAttempts: BenchmarkModelAttempt[];
  /** Full CheckSummary when CHECK ran; absent when the run died earlier. */
  checker?: CheckSummary;
  reworkRounds?: number;
  cost: { totalUsd: number; inputTokens: number; outputTokens: number; entries: CostEntry[] };
  git: { changedFiles: string[]; diffStat: string; diffBase: string };
  failure?: BenchmarkRunFailure;
  /** Relative paths (within the artifact dir) + absolute references for collectors. */
  artifacts: {
    manifest: 'manifest.json';
    request: 'request.json';
    events: 'events.ndjson';
    diff: 'diff.patch';
    /** Absolute path of the Markdown local-run report, when one was written. */
    report?: string;
    /** Absolute path of the frozen spec, when it exists. */
    spec?: string;
  };
}

export interface BenchmarkArtifactsInput {
  issue: number;
  artifactsDir: string;
  eventsFile: string;
  costsFile: string;
  startedAt: string;
  outcome: 'ready' | 'failed' | 'parked' | 'escalated';
  workspace: string;
  branch?: string;
  specPath?: string;
  route?: string;
  request?: WorkRequest;
  checkSummary?: CheckSummary;
  reworkRounds?: number;
  failure?: BenchmarkRunFailure;
  reportPath?: string;
  /** Captured run-start HEAD SHA (ADR-0079/#1210), used as the diff base when
   *  origin/main...HEAD cannot be resolved (e.g. a local-only workspace with no
   *  remote). Absent means no captured base is available. */
  diffBase?: string;
}

interface GatheredRunData {
  endedAt: string;
  events: FactoryEvent[];
  costs: CostEntry[];
  changedFiles: string[];
  diffStat: string;
  diffBase: string;
}

const WORKER_PHASE_ORDER: FailurePhase[] = ['plan', 'build', 'check', 'ship'];

function computePhases(failure?: BenchmarkRunFailure): { plan: string; build: string; check: string; ship: 'skipped' } {
  if (!failure) return { plan: 'ok', build: 'ok', check: 'ok', ship: 'skipped' };
  const failedIndex = WORKER_PHASE_ORDER.indexOf(failure.phase);
  const outcomeFor = (phase: FailurePhase): string => {
    const index = WORKER_PHASE_ORDER.indexOf(phase);
    if (index < failedIndex) return 'ok';
    if (index === failedIndex) return 'failed';
    return 'skipped';
  };
  return { plan: outcomeFor('plan'), build: outcomeFor('build'), check: outcomeFor('check'), ship: 'skipped' };
}

/** Pure assembly of the manifest from resolved input + gathered run data. */
export function buildBenchmarkManifest(input: BenchmarkArtifactsInput, gathered: GatheredRunData): BenchmarkManifest {
  const startedMs = Date.parse(input.startedAt);
  const endedMs = Date.parse(gathered.endedAt);
  const elapsedMs = Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0;
  const cost = gathered.costs.reduce(
    (acc, entry) => ({
      totalUsd: acc.totalUsd + entry.cost,
      inputTokens: acc.inputTokens + entry.inputTokens,
      outputTokens: acc.outputTokens + entry.outputTokens,
    }),
    { totalUsd: 0, inputTokens: 0, outputTokens: 0 },
  );

  return {
    manifestVersion: BENCHMARK_MANIFEST_VERSION,
    run: {
      issue: input.issue,
      profile: 'local-only',
      outcome: input.outcome,
      startedAt: input.startedAt,
      endedAt: gathered.endedAt,
      elapsedMs,
      workspace: input.workspace,
      branch: input.branch,
      specPath: input.specPath,
      route: input.route,
    },
    request: input.request,
    phases: computePhases(input.failure),
    modelAttempts: parseModelAttempts(gathered.events),
    checker: input.checkSummary,
    reworkRounds: input.reworkRounds,
    cost: { ...cost, entries: gathered.costs },
    git: { changedFiles: gathered.changedFiles, diffStat: gathered.diffStat, diffBase: gathered.diffBase },
    failure: input.failure,
    artifacts: {
      manifest: 'manifest.json',
      request: 'request.json',
      events: 'events.ndjson',
      diff: 'diff.patch',
      report: input.reportPath,
      spec: input.specPath && existsSync(input.specPath) ? input.specPath : undefined,
    },
  };
}

async function readChangedFiles(workspace: string, run: ReportRun): Promise<string[]> {
  try {
    const result = await run('git status --short', { cwd: workspace, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readDiff(
  workspace: string,
  run: ReportRun,
  capturedDiffBase?: string,
): Promise<{ diffStat: string; diffPatch: string; diffBase: string }> {
  try {
    const stat = await run('git diff --stat origin/main...HEAD', {
      cwd: workspace,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const patch = await run('git diff origin/main...HEAD', {
      cwd: workspace,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { diffStat: stat.stdout.trim(), diffPatch: patch.stdout, diffBase: 'origin/main...HEAD' };
  } catch {
    if (capturedDiffBase && /^[0-9a-f]{4,64}$/i.test(capturedDiffBase)) {
      try {
        const stat = await run(`git diff --stat ${capturedDiffBase}..HEAD`, {
          cwd: workspace,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        const patch = await run(`git diff ${capturedDiffBase}..HEAD`, {
          cwd: workspace,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        return { diffStat: stat.stdout.trim(), diffPatch: patch.stdout, diffBase: capturedDiffBase };
      } catch {
        return { diffStat: '', diffPatch: '', diffBase: 'none' };
      }
    }
    return { diffStat: '', diffPatch: '', diffBase: 'none' };
  }
}

/** Write the benchmark artifact manifest + supporting files for a completed
 *  (or failed) local-only run. Fixed, deterministic filenames inside
 *  `input.artifactsDir` so a harness can collect them without scraping logs. */
export async function writeBenchmarkArtifacts(
  input: BenchmarkArtifactsInput,
  deps: { now?: () => Date; run?: ReportRun } = {},
): Promise<{ dir: string; manifestPath: string; manifest: BenchmarkManifest }> {
  const now = deps.now ?? (() => new Date());
  const run = deps.run ?? exec;
  const endedAt = now().toISOString();

  const events = readIssueEvents(input.eventsFile, input.issue, input.startedAt);
  const startedMs = Date.parse(input.startedAt);
  const costs = readCosts(input.costsFile).filter(
    (entry) =>
      entry.issue === String(input.issue) && (!Number.isFinite(startedMs) || Date.parse(entry.ts) >= startedMs),
  );
  const changedFiles = await readChangedFiles(input.workspace, run);
  const { diffStat, diffPatch, diffBase } = await readDiff(input.workspace, run, input.diffBase);

  const manifest = buildBenchmarkManifest(input, { endedAt, events, costs, changedFiles, diffStat, diffBase });

  const dir = input.artifactsDir;
  const manifestPath = resolve(dir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(dir, 'request.json'), `${JSON.stringify(input.request ?? {}, null, 2)}\n`);
  const eventsContent = events.map((event) => JSON.stringify(event)).join('\n');
  writeFileSync(resolve(dir, 'events.ndjson'), eventsContent.length > 0 ? `${eventsContent}\n` : '');
  writeFileSync(resolve(dir, 'diff.patch'), diffPatch);

  return { dir, manifestPath, manifest };
}
