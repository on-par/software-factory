// packages/cli/src/cli/run-brief.ts — the factory run-brief handler, moved out of index.ts (#3762)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  runStack,
  workKeyFromIssue,
  type LocalBriefParams,
  type LocalOnlyPolicy,
  type RunOutcome,
  type SizeGateMode,
  type WorkRequest,
} from '@on-par/factory-core';
import { fileSlicePlanStore, logEvent, type SlicePlanStore } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { availableAgentClis, missingAgentCliMessage, notInitializedMessage } from './first-run.js';
import { withRepoRunLock } from './repo-run-lock.js';
import { recordDraftPrFlag } from './run-flags.js';
import { shipIssue } from './ship.js';
import { baseBranchConflict, baseBranchOrExit } from './ship-options.js';
import { consoleStackLog, printStackResult, runSliceStack } from './stack-run.js';

/** index.ts bindings the handler needs; index.ts passes them so this module never imports it at runtime. */
export interface RunBriefRuntime {
  isCommandAvailable: (cmd: string) => boolean;
  getRepoRoot: () => Promise<string>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  branchPrefixOrExit: (raw: string | undefined, configPath: string) => string;
  errorDetail: (err: unknown) => string;
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
  baseBranch?: string;
  draftPr?: boolean;
  /** --stack (#3763): brief N+1 bases on brief N's PR head branch; stops at the first failure or missing PR. */
  stack?: boolean;
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
  if (files.length === 1 && opts.stack) {
    await runStackedBrief(files[0], opts, env, rt);
    return;
  }
  if (files.length === 1) {
    await runOneBrief(files[0], opts, env, rt);
    return;
  }

  console.log(styleText('cyan', `run-brief: ${files.length} briefs — running them in order`));
  if (opts.stack) {
    console.log(styleText('cyan', "run-brief: --stack — each brief bases on the previous brief's PR head"));
  }
  const result = await runStack(
    files.map((file) => ({
      title: file,
      run: async (base) => {
        const o = await runOneBrief(
          file,
          opts.stack ? { ...opts, baseBranch: base, sizeGate: 'off' as const } : opts,
          env,
          rt,
        );
        return (
          o && { prNumber: 'prNumber' in o ? o.prNumber : undefined, branch: 'branch' in o ? o.branch : undefined }
        );
      },
    })),
    { base: opts.baseBranch, chain: opts.stack === true, prefix: 'run-brief', noun: 'brief', log: consoleStackLog },
  );
  printStackResult(result, 'Run failed for one or more briefs (listed above)');
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
  baseBranchOrExit(opts.baseBranch);
  const conflict = baseBranchConflict({ baseBranch: opts.baseBranch, workspace: opts.workspace });
  if (conflict) throw new CliExitError(conflict, 2);
  if (opts.stack && opts.workspace !== undefined) {
    throw new CliExitError('factory: --stack needs factory worktrees and PRs — drop --workspace or drop --stack', 2);
  }

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

type BriefEnv = Awaited<ReturnType<typeof prepareRunBrief>>;

/** `run-brief <file> --stack` (#3813): an over-budget brief is sliced and its slices build as a stack in
 *  this one run; the slice plan lives in the run's state file, not on any issue. */
async function runStackedBrief(file: string, opts: RunBriefOptions, env: BriefEnv, rt: RunBriefRuntime): Promise<void> {
  const { runNum } = await resolveBrief(file, env, rt);
  const store = fileSlicePlanStore(join(env.paths.state, 'slice-plans', `${runNum}.md`));
  await runSliceStack({ prefix: 'run-brief', label: file, failLabel: `brief ${file}` }, opts.baseBranch, {
    readSlicePlan: async () => {
      const lookup = await store.find();
      return lookup.status === 'found' ? lookup.plan : undefined;
    },
    ship: async (base, onOutcome) => {
      const outcome = await runOneBrief(file, { ...opts, baseBranch: base, sizeGate: 'stack' }, env, rt, {
        slicePlanStore: store,
      });
      if (outcome) onOutcome(outcome);
    },
  });
}

/** Resolves the brief through the canonical work-request seam BEFORE any worktree or PR exists. */
async function resolveBrief(briefPath: string, env: BriefEnv, rt: RunBriefRuntime) {
  let work: WorkRequest;
  try {
    work = await env.workSources.resolve(LOCAL_BRIEF_SOURCE, { path: briefPath } satisfies LocalBriefParams);
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
  return { work, digest, runNum: briefRunNumber(digest) };
}

/** One brief through the one-shot pipeline under its own per-brief lock. Throws CliExitError(2) when
 *  the brief cannot be resolved (no worktree or PR exists yet) and CliExitError(1) on a pipeline failure. */
async function runOneBrief(
  briefPath: string,
  opts: RunBriefOptions & { sizeGate?: SizeGateMode },
  env: BriefEnv,
  rt: RunBriefRuntime,
  extra?: { slicePlanStore?: SlicePlanStore },
): Promise<RunOutcome | undefined> {
  const { repoRoot, paths, branchPrefix, localOnly, artifactsDir, ghRepo } = env;

  // Pre-flight: a malformed brief exits here, so BUILD never starts.
  const { work, digest, runNum } = await resolveBrief(briefPath, env, rt);

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
            slicePlanStore: extra?.slicePlanStore,
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
