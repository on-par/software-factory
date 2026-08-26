// src/ingest/index.ts — Always-on auto-ingest: poll for "ready" issues and mark them queued in GitHub.
import { readFileSync, writeFileSync } from 'node:fs';

import { laneLabel, QUEUED_LABEL } from '../queue/github-queue.js';
import type { CommandResult } from '../utils/command-runner.js';
import { runCommand } from '../utils/command-runner.js';
import { branchPrefixSlug } from '../utils/index.js';

const DEFAULT_LABEL = 'ready';
const DEFAULT_LANE = 'auto';
const DEFAULT_MAX_PER_CYCLE = 20;

// ---------- Branch parsing ----------

/** Extract the issue number from a factory branch like "ship-it/388-foo". Returns null otherwise. */
export function issueFromFactoryBranch(branch: string, prefix: string): number | null {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escapedPrefix}/(\\d+)-`).exec(branch);
  return match ? parseInt(match[1], 10) : null;
}

// ---------- Types ----------

export interface AutoIngestOptions {
  repoDir: string;
  watermarkFile: string;
  /** Ready-signal label. Defaults to 'ready'. */
  label?: string;
  /** Queue lane new issues are appended under. Defaults to 'auto'. */
  lane?: string;
  /** Cap on issues appended per cycle. Defaults to 20. */
  maxPerCycle?: number;
  /** Factory branch prefix used to recognize in-flight PRs. Defaults to branchPrefixSlug(). */
  branchPrefix?: string;
}

type Runner = (argv: readonly string[], opts: { cwd: string }) => Promise<Pick<CommandResult, 'stdout' | 'ok'>>;

export interface AutoIngestDeps {
  now?: () => Date;
  run?: Runner;
  /** Returns null when the file is missing or unreadable. Used only for the ingest watermark. */
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, content: string) => void;
}

export interface AutoIngestResult {
  scannedAt: string;
  /** Ready issues listed by gh. */
  candidates: number;
  /** Issue numbers appended, in queue order. */
  appended: number[];
  skippedInQueue: number[];
  skippedInFlight: number[];
  /** Filtered out by the watermark (not updated since the previous cycle). */
  skippedStale: number[];
  /** Watermark persisted after this cycle. */
  watermark: string;
}

interface ReadyIssue {
  number: number;
  title: string;
  updatedAt: string;
  labels: string[];
}

// ---------- Default deps ----------

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

// ---------- gh CLI helpers ----------

async function listReadyIssues(
  run: Runner,
  repoDir: string,
  label: string,
  limit: number,
): Promise<{ ok: boolean; issues: ReadyIssue[] }> {
  const result = await run(
    [
      'gh',
      'issue',
      'list',
      '--label',
      label,
      '--state',
      'open',
      '--limit',
      String(limit),
      '--json',
      'number,title,updatedAt,labels',
    ],
    { cwd: repoDir },
  );
  if (!result.ok) return { ok: false, issues: [] };
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return { ok: false, issues: [] };
    const issues = (parsed as Array<{ number?: unknown; title?: unknown; updatedAt?: unknown; labels?: unknown }>)
      .filter(
        (item): item is { number: number; title: string; updatedAt: string; labels?: unknown } =>
          typeof item.number === 'number' && typeof item.title === 'string' && typeof item.updatedAt === 'string',
      )
      .map((item) => ({
        number: item.number,
        title: item.title,
        updatedAt: item.updatedAt,
        labels: Array.isArray(item.labels)
          ? item.labels
              .map((label) => (typeof label === 'string' ? label : (label as { name?: unknown }).name))
              .filter((name): name is string => typeof name === 'string' && name !== '')
          : [],
      }));
    return { ok: true, issues };
  } catch {
    return { ok: false, issues: [] };
  }
}

async function ensureQueueLabel(run: Runner, repoDir: string, name: string, color: string, description: string) {
  await run(['gh', 'label', 'create', name, '--color', color, '--description', description], { cwd: repoDir });
}

async function markIssueQueued(run: Runner, repoDir: string, issue: number, lane: string): Promise<boolean> {
  const labels = [QUEUED_LABEL, laneLabel(lane)];
  await Promise.all([
    ensureQueueLabel(run, repoDir, QUEUED_LABEL, '0e8a16', 'Eligible to be claimed by a factory lane'),
    ensureQueueLabel(run, repoDir, laneLabel(lane), '1d76db', `Routed to factory lane ${lane}`),
  ]);
  const result = await run(['gh', 'issue', 'edit', String(issue), '--add-label', labels.join(',')], { cwd: repoDir });
  return result.ok;
}

async function listInFlightIssues(run: Runner, repoDir: string, branchPrefix: string): Promise<Set<number>> {
  const result = await run(['gh', 'pr', 'list', '--state', 'open', '--limit', '200', '--json', 'headRefName'], {
    cwd: repoDir,
  });
  const inFlight = new Set<number>();
  if (!result.ok) return inFlight;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return inFlight;
    for (const item of parsed as Array<{ headRefName?: unknown }>) {
      if (typeof item.headRefName !== 'string') continue;
      const issue = issueFromFactoryBranch(item.headRefName, branchPrefix);
      if (issue !== null) inFlight.add(issue);
    }
  } catch {
    return inFlight;
  }
  return inFlight;
}

// ---------- Main entry point ----------

export async function runAutoIngest(options: AutoIngestOptions, deps: AutoIngestDeps = {}): Promise<AutoIngestResult> {
  const now = deps.now ?? (() => new Date());
  const run = deps.run ?? ((argv: readonly string[], o: { cwd: string }) => runCommand(argv, { cwd: o.cwd }));
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? writeFileSync;

  const { repoDir, watermarkFile } = options;
  const label = options.label ?? DEFAULT_LABEL;
  const lane = options.lane ?? DEFAULT_LANE;
  const maxPerCycle = options.maxPerCycle ?? DEFAULT_MAX_PER_CYCLE;
  const branchPrefix = options.branchPrefix ?? branchPrefixSlug();

  const scannedAt = now().toISOString();
  const prevWatermark = readFile(watermarkFile)?.trim() || undefined;

  const [{ ok: listOk, issues: readyIssues }, inFlight] = await Promise.all([
    listReadyIssues(run, repoDir, label, maxPerCycle * 5),
    listInFlightIssues(run, repoDir, branchPrefix),
  ]);
  if (!listOk) {
    // Don't advance past unseen work: leave the watermark exactly as it was.
    return {
      scannedAt,
      candidates: 0,
      appended: [],
      skippedInQueue: [],
      skippedInFlight: [],
      skippedStale: [],
      watermark: prevWatermark ?? scannedAt,
    };
  }

  const appended: number[] = [];
  const skippedInQueue: number[] = [];
  const skippedInFlight: number[] = [];
  const skippedStale: number[] = [];
  const toAppend: ReadyIssue[] = [];

  for (const issue of [...readyIssues].sort((a, b) => a.number - b.number)) {
    if (prevWatermark && issue.updatedAt <= prevWatermark) {
      skippedStale.push(issue.number);
      continue;
    }
    if (issue.labels.includes(QUEUED_LABEL)) {
      skippedInQueue.push(issue.number);
      continue;
    }
    if (inFlight.has(issue.number)) {
      skippedInFlight.push(issue.number);
      continue;
    }
    toAppend.push(issue);
  }

  const capped = toAppend.slice(0, maxPerCycle);
  const deferred = toAppend.slice(maxPerCycle);

  if (capped.length > 0) {
    for (const issue of capped) {
      if (await markIssueQueued(run, repoDir, issue.number, lane)) {
        appended.push(issue.number);
      }
    }
  }

  // Never advance the watermark up to or past an issue the maxPerCycle cap deferred this
  // cycle — otherwise it would be misclassified as stale (and permanently dropped) next cycle.
  const deferredCeiling = deferred.reduce<string | undefined>(
    (min, issue) => (min === undefined || issue.updatedAt < min ? issue.updatedAt : min),
    undefined,
  );

  let watermark = prevWatermark;
  for (const issue of readyIssues) {
    if (deferredCeiling !== undefined && issue.updatedAt >= deferredCeiling) continue;
    if (watermark === undefined || issue.updatedAt > watermark) watermark = issue.updatedAt;
  }
  watermark = watermark ?? scannedAt;

  if (watermark !== prevWatermark) writeFile(watermarkFile, `${watermark}\n`);

  return {
    scannedAt,
    candidates: readyIssues.length,
    appended,
    skippedInQueue,
    skippedInFlight,
    skippedStale,
    watermark,
  };
}
