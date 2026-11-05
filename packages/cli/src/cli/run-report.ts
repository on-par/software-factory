// packages/cli/src/cli/run-report.ts — `--json` final run result and `--export` of run state for disposable hosts (#3907)

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  phaseSnapshotFile,
  readEvents,
  workKeyFromIssue,
  type getFactoryPaths,
  type RunOutcome,
} from '@on-par/factory-core';
import { readCosts, runStateFile } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import type { RunResultJson } from './json-contract.js';
import type { MergeResult } from './run-issue-merge.js';
import { buildRunResult } from './run-result.js';

export interface RunReportOptions {
  json?: boolean;
  export?: string;
}

export interface RunReportContext {
  issue: number;
  repoRoot: string;
  paths: ReturnType<typeof getFactoryPaths>;
  /** The run's branch when the pipeline did not report one. */
  branch?: () => string | undefined;
  baseRef?: string;
  getRepo: () => Promise<string>;
}

export interface RunReportSink {
  recordOutcome(o: RunOutcome): void;
  recordMerge(r: MergeResult): void;
  recordError(e: unknown): void;
}

export interface RunReportDeps {
  now?: () => Date;
  revParse?: (repoRoot: string, ref: string) => string | null;
  stdout?: { write(s: string): unknown };
}

const noopSink: RunReportSink = { recordOutcome: () => {}, recordMerge: () => {}, recordError: () => {} };

function gitRevParse(repoRoot: string, ref: string): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Refuses the flag combinations --json/--export cannot report on; exit 2 before any run starts. */
export function validateRunReportFlags(opts: {
  json?: boolean;
  export?: string;
  stack?: boolean;
  briefCount?: number;
}): void {
  if (opts.export === '') throw new CliExitError('factory: --export needs a directory', 2);
  if (!opts.json && opts.export === undefined) return;
  if (opts.stack) throw new CliExitError('factory: --json/--export report one run — drop --stack', 2);
  if ((opts.briefCount ?? 1) > 1) throw new CliExitError('factory: --json/--export take exactly one brief', 2);
}

/** Copies this issue's run state, events and cost rows plus the result into `dir`; returns the written paths. */
export function exportRunState(
  dir: string,
  paths: ReturnType<typeof getFactoryPaths>,
  issue: number,
  result: RunResultJson,
): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const key = workKeyFromIssue(issue);
  for (const source of [runStateFile(paths.runs, key), phaseSnapshotFile(paths.runs, key)]) {
    if (!existsSync(source)) continue;
    const target = join(dir, basename(source));
    copyFileSync(source, target);
    written.push(target);
  }
  const issueKey = String(issue);
  const lines = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  const files: [string, string][] = [
    ['events.ndjson', lines(readEvents(paths.events, { includeSegments: true }).filter((e) => e.issue === issueKey))],
    ['costs.jsonl', lines(readCosts(paths.costs).filter((c) => c.issue === issueKey))],
    ['run-result.json', `${JSON.stringify(result, null, 2)}\n`],
  ];
  for (const [name, content] of files) {
    const target = join(dir, name);
    writeFileSync(target, content);
    written.push(target);
  }
  return written;
}

/** Runs `run` and, when --json/--export is set, reports on it on every exit path; the run's error is re-thrown unchanged. */
export async function withRunReport(
  opts: RunReportOptions,
  ctx: RunReportContext,
  run: (sink: RunReportSink) => Promise<void>,
  deps: RunReportDeps = {},
): Promise<void> {
  if (!opts.json && opts.export === undefined) return run(noopSink);
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const seen: { outcome?: RunOutcome; merge?: MergeResult; error?: unknown } = {};
  const sink: RunReportSink = {
    recordOutcome: (o) => {
      seen.outcome = o;
    },
    recordMerge: (r) => {
      seen.merge = r;
    },
    recordError: (e) => {
      seen.error = e;
    },
  };
  const savedLog = console.log;
  const savedInfo = console.info;
  if (opts.json) {
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = (...args: unknown[]) => console.error(...args);
  }
  let thrown: unknown;
  let failed = false;
  try {
    await run(sink);
  } catch (e) {
    sink.recordError(e);
    thrown = e;
    failed = true;
  } finally {
    console.log = savedLog;
    console.info = savedInfo;
    const repo = await ctx.getRepo().catch(() => null);
    const revParse = deps.revParse ?? gitRevParse;
    const branch = seen.outcome?.branch ?? ctx.branch?.();
    const headSha = branch
      ? (revParse(ctx.repoRoot, `refs/heads/${branch}`) ?? revParse(ctx.repoRoot, `origin/${branch}`))
      : null;
    const result = buildRunResult({
      issue: ctx.issue,
      repo,
      outcome: seen.outcome,
      merge: seen.merge,
      error: seen.error,
      startedAt,
      finishedAt: now().toISOString(),
      branch,
      baseSha: revParse(ctx.repoRoot, ctx.baseRef ?? 'origin/HEAD'),
      headSha,
      events: readEvents(ctx.paths.events, { includeSegments: true }),
      costs: readCosts(ctx.paths.costs),
    });
    if (opts.export !== undefined) {
      try {
        exportRunState(opts.export, ctx.paths, ctx.issue, result);
      } catch (e) {
        console.error(`factory: --export failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (opts.json) (deps.stdout ?? process.stdout).write(`${JSON.stringify(result)}\n`);
  }
  if (failed) throw thrown;
}
