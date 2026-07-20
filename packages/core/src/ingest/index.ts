// src/ingest/index.ts — Always-on auto-ingest: poll for "ready" issues and append them to the queue
import { readFileSync, writeFileSync } from 'node:fs';

import { parseQueue } from '../queue/index.js';
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
  queueFile: string;
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
  /** Returns null when the file is missing or unreadable. */
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
      'number,title,updatedAt',
    ],
    { cwd: repoDir },
  );
  if (!result.ok) return { ok: false, issues: [] };
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return { ok: false, issues: [] };
    const issues = (parsed as Array<{ number?: unknown; title?: unknown; updatedAt?: unknown }>)
      .filter(
        (item): item is { number: number; title: string; updatedAt: string } =>
          typeof item.number === 'number' && typeof item.title === 'string' && typeof item.updatedAt === 'string',
      )
      .map((item) => ({ number: item.number, title: item.title, updatedAt: item.updatedAt }));
    return { ok: true, issues };
  } catch {
    return { ok: false, issues: [] };
  }
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

  const { repoDir, queueFile, watermarkFile } = options;
  const label = options.label ?? DEFAULT_LABEL;
  const lane = options.lane ?? DEFAULT_LANE;
  const maxPerCycle = options.maxPerCycle ?? DEFAULT_MAX_PER_CYCLE;
  const branchPrefix = options.branchPrefix ?? branchPrefixSlug();

  const scannedAt = now().toISOString();
  const prevWatermark = readFile(watermarkFile)?.trim() || undefined;

  const { ok: listOk, issues: readyIssues } = await listReadyIssues(run, repoDir, label, maxPerCycle * 5);
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

  const queueContent = readFile(queueFile) ?? '';
  const inQueue = new Set(parseQueue(queueContent).entries.map((e) => e.issue));
  const inFlight = await listInFlightIssues(run, repoDir, branchPrefix);

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
    if (inQueue.has(issue.number)) {
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

  if (capped.length > 0) {
    const needsNewline = queueContent.length > 0 && !queueContent.endsWith('\n');
    const appendedLines = capped.map((issue) => `${lane} ${issue.number}\n`).join('');
    const newContent = (needsNewline ? `${queueContent}\n` : queueContent) + appendedLines;
    writeFile(queueFile, newContent);
    appended.push(...capped.map((issue) => issue.number));
  }

  let watermark = prevWatermark;
  for (const issue of readyIssues) {
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
