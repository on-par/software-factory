// packages/cli/src/cli/run-brief.ts — the factory run-brief handler, moved out of index.ts (#3762)

import { existsSync } from 'node:fs';
import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import {
  createDefaultWorkSourceRegistry,
  getFactoryPaths,
  hasUnresolvedPark,
  InvalidArtifactsDirError,
  InvalidWorkRequestInputError,
  InvalidWorkspaceError,
  LOCAL_BRIEF_SOURCE,
  readEvents,
  resolveArtifactsDir,
  resolveLocalOnlyPolicy,
  workKeyFromIssue,
  type LocalBriefParams,
  type LocalOnlyPolicy,
  type RunOutcome,
  type WorkRequest,
} from '@on-par/factory-core';
import { logEvent } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { availableAgentClis, missingAgentCliMessage, notInitializedMessage } from './first-run.js';
import { withRepoRunLock } from './repo-run-lock.js';
import { recordDraftPrFlag } from './run-flags.js';
import { shipIssue } from './ship.js';

/** index.ts bindings the handler needs; index.ts passes them so this module never imports it at runtime. */
export interface RunBriefRuntime {
  isCommandAvailable: (cmd: string) => boolean;
  getRepoRoot: () => Promise<string>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  branchPrefixOrExit: (raw: string | undefined, configPath: string) => string;
  errorDetail: (err: unknown) => string;
}

interface BriefRunResult {
  file: string;
  status: 'ready' | 'failed';
  prNumber?: number;
  detail?: string;
}

/** Deterministic run number for a brief, derived from its content digest.
 *  Reserved 9,000,000+ range keeps brief branches/worktrees clear of real issue numbers. */
function briefRunNumber(sha256Hex: string): number {
  return 9_000_000 + (Number.parseInt(sha256Hex.slice(0, 8), 16) % 1_000_000);
}

export interface RunBriefOptions {
  product?: string;
  autoRework?: boolean;
  interactive?: boolean;
  /** `--no-pr` sets false: stop after CHECK, no GitHub writes. */
  pr?: boolean;
  sandbox?: boolean;
  approvePlan?: boolean;
  workspace?: string;
  artifacts?: string;
  branchPrefix?: string;
  draftPr?: boolean;
}

/** Runs each brief through the one-shot pipeline in argv order with the same flags. The checks that
 *  hold for every brief (agent CLI, init, flags, GitHub remote) run once up front and abort the whole
 *  invocation; a failure of one brief (missing file, malformed brief, lock refusal, pipeline failure)
 *  is recorded and the next brief still runs. With several briefs a per-brief summary is printed and
 *  CliExitError(1) is thrown if any failed (#3762). */
export async function cmdRunBrief(files: readonly string[], opts: RunBriefOptions, rt: RunBriefRuntime): Promise<void> {
  if (files.length === 0) {
    throw new CliExitError(
      'factory: run-brief needs at least one brief file — usage: factory run-brief <file> [file...]',
      2,
    );
  }
  if (files.length > 1 && opts.artifacts !== undefined) {
    throw new CliExitError(
      'factory: --artifacts takes exactly one brief (each run writes the same manifest files) — run the briefs one at a time',
      2,
    );
  }
  const env = await prepareRunBrief(opts, rt);
  if (files.length === 1) {
    await runOneBrief(files[0], opts, env, rt);
    return;
  }

  console.log(styleText('cyan', `run-brief: ${files.length} briefs — running them in order`));
  const results: BriefRunResult[] = [];
  for (const [i, file] of files.entries()) {
    console.log(styleText('cyan', `run-brief: [${i + 1}/${files.length}] ${file}`));
    try {
      const outcome = await runOneBrief(file, opts, env, rt);
      results.push({
        file,
        status: 'ready',
        prNumber: outcome && 'prNumber' in outcome ? outcome.prNumber : undefined,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(styleText('red', detail));
      results.push({ file, status: 'failed', detail });
    }
  }
  const ok = results.every((r) => r.status === 'ready');
  for (const line of formatBriefRunSummary(results)) {
    console.log(ok ? styleText('green', line) : styleText('yellow', line));
  }
  if (!ok) {
    throw new CliExitError('Run failed for one or more briefs (listed above)', 1);
  }
}

/** The run-brief pre-flight shared by every brief in one invocation; any failure here exits 2. */
async function prepareRunBrief(opts: RunBriefOptions, rt: RunBriefRuntime) {
  if (availableAgentClis(rt.isCommandAvailable).length === 0) {
    throw new CliExitError(`factory: ${missingAgentCliMessage()}`, 2);
  }
  const repoRoot = await rt.getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.root)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }

  const branchPrefix = rt.branchPrefixOrExit(opts.branchPrefix, paths.config);

  let localOnly: LocalOnlyPolicy | undefined;
  if (opts.workspace !== undefined) {
    try {
      localOnly = resolveLocalOnlyPolicy(opts.workspace);
    } catch (err) {
      if (err instanceof InvalidWorkspaceError) throw new CliExitError(`factory: ${err.message}`, 2);
      throw err;
    }
  }

  let artifactsDir: string | undefined;
  if (opts.artifacts !== undefined) {
    if (!localOnly) {
      throw new CliExitError('factory: --artifacts requires --workspace (local-only runs only)', 2);
    }
    try {
      artifactsDir = resolveArtifactsDir(opts.artifacts);
    } catch (err) {
      if (err instanceof InvalidArtifactsDirError) throw new CliExitError(`factory: ${err.message}`, 2);
      throw err;
    }
    console.log(styleText('cyan', `local-only: benchmark artifacts will be written to ${artifactsDir}`));
  }

  // Local-only runs never touch GitHub — no remote required, no mutation possible.
  const ghRepo = localOnly ? 'local/workspace' : await rt.getGitHubRepo();
  const workSources = createDefaultWorkSourceRegistry({ octokit: rt.getOctokit() });
  return { repoRoot, paths, branchPrefix, localOnly, artifactsDir, ghRepo, workSources };
}

/** One brief through the one-shot pipeline under its own per-brief lock. Throws CliExitError(2) when
 *  the brief cannot be resolved (no worktree or PR exists yet) and CliExitError(1) on a pipeline failure. */
async function runOneBrief(
  briefPath: string,
  opts: RunBriefOptions,
  env: Awaited<ReturnType<typeof prepareRunBrief>>,
  rt: RunBriefRuntime,
): Promise<RunOutcome | undefined> {
  const { repoRoot, paths, branchPrefix, localOnly, artifactsDir, ghRepo, workSources } = env;

  // Pre-flight: resolve the brief through the canonical work-request seam
  // BEFORE any worktree or PR exists — a malformed brief exits here, so BUILD never starts.
  let work: WorkRequest;
  try {
    work = await workSources.resolve(LOCAL_BRIEF_SOURCE, { path: briefPath } satisfies LocalBriefParams);
  } catch (err) {
    if (err instanceof InvalidWorkRequestInputError) {
      throw new CliExitError(`factory: ${err.message}`, 2);
    }
    throw new CliExitError(
      `factory: could not resolve brief at ${briefPath} (${rt.errorDetail(err)}) — no worktree or PR was created`,
      2,
    );
  }
  const digest = work.reference?.externalId ?? '';
  const runNum = briefRunNumber(digest);

  let outcome: RunOutcome | undefined;
  await withRepoRunLock(
    paths,
    'factory run-brief',
    async () => {
      recordDraftPrFlag(paths.runFlags, opts.draftPr);
      console.log(styleText('cyan', `one-shot: resolved ${work.id} — running the pipeline (queue untouched)`));
      logEvent(paths.events, 'work-source', runNum, `inline local brief ${briefPath} (sha256 ${digest})`);
      if (localOnly) {
        console.log(styleText('cyan', `local-only: workspace ${localOnly.workspace} — publishing disabled`));
        logEvent(
          paths.events,
          'local-only',
          runNum,
          `caller-provided workspace ${localOnly.workspace} — publishing disabled`,
        );
      }

      const priorEvents = readEvents(paths.events, { includeSegments: true });
      if (hasUnresolvedPark(priorEvents, String(runNum))) {
        logEvent(paths.events, 'human-restarted', runNum, 'manual retry of a previously parked/failed run', {
          actor: process.env.FACTORY_ACTOR ?? process.env.USER ?? 'unknown',
        });
      }

      try {
        await shipIssue(
          runNum,
          { ...opts, branchPrefix },
          {
            repoRoot,
            ghRepo,
            workRequest: work,
            workSource: { kind: LOCAL_BRIEF_SOURCE, params: { path: briefPath } satisfies LocalBriefParams },
            localOnly,
            artifactsDir,
            onOutcome: (o) => {
              outcome = o;
            },
          },
        );
      } catch (err: any) {
        throw new CliExitError(`Run failed for brief ${briefPath}: ${err.message}`, 1);
      }
    },
    { scope: { kind: 'issue', key: workKeyFromIssue(runNum) } },
  );
  return outcome;
}

/** Renders the per-brief summary lines in run order; the caller colours and prints them. */
function formatBriefRunSummary(results: readonly BriefRunResult[]): string[] {
  const lines = ['Briefs:'];
  for (const r of results) {
    if (r.status === 'ready') {
      lines.push(r.prNumber !== undefined ? `  ${r.file} → PR #${r.prNumber}` : `  ${r.file} → done (no PR)`);
    } else {
      lines.push(r.detail ? `  ${r.file} → failed: ${r.detail}` : `  ${r.file} → failed`);
    }
  }
  const done = results.filter((r) => r.status === 'ready').length;
  lines.push(`${done}/${results.length} briefs succeeded`);
  return lines;
}
