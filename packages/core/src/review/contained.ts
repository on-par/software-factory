// packages/core/src/review/contained.ts — runs a fork PR's checkers inside a disposable container (#1685)
// and tears that container down on every exit path, including SIGINT/SIGTERM (#1686).

import { summarizeCheckerOutputs } from '../checkers/index.js';
import {
  laneContainerName,
  provisionLaneContainer,
  type ContainerEngine,
  type LaneContainerRemoval,
  type LaneExecResult,
} from '../hosted/container.js';
import type { CheckerOutput, CheckSummary } from '../types/index.js';
import type { ReviewPullRequestRepos } from './containment.js';

/** Minimal signal port so tests can simulate an interrupt; defaults to `process`. */
export interface ReviewInterruptSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface ContainedReviewDeps {
  engine: ContainerEngine;
  pr: ReviewPullRequestRepos;
  /** Run id used in the container name (sf-job-<runId>-review-pr-<n>). */
  runId: string;
  /** constitution.requireTests — a missing test script becomes FAIL instead of SKIP. */
  testsRequired?: boolean;
  /** Per-command timeout in ms; default 300_000. */
  timeoutMs?: number;
  /** Interrupt source for teardown-on-signal; defaults to `process`. */
  signals?: ReviewInterruptSource;
  /** Called after teardown on SIGINT (130) / SIGTERM (143); defaults to `process.exit`. */
  exit?: (code: number) => void;
}

export type ContainedReviewResult =
  | { ok: true; summary: CheckSummary; containerName: string; commit?: string; teardown?: LaneContainerRemoval }
  | { ok: false; error: string; containerName?: string; teardown?: LaneContainerRemoval };

const DEFAULT_TIMEOUT_MS = 300_000;
const READ_TIMEOUT_MS = 30_000;
const REPO_PATH = '/workspace/repo';
const HOST_ONLY_SKIP = 'not run in a contained review (host-only checker)';
const INSTALL_COMMAND = ['sh', '-c', 'if [ -f package-lock.json ]; then npm ci; else npm install; fi'];

const tail = (text: string): string => text.slice(-500);

export function pullRequestHeadRef(prNumber: number): string {
  return `refs/pull/${prNumber}/head`;
}

function scriptsFrom(raw: string): Record<string, string> | 'invalid' {
  try {
    const parsed: unknown = JSON.parse(raw);
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    if (scripts && typeof scripts === 'object') return scripts as Record<string, string>;
    return {};
  } catch {
    return 'invalid';
  }
}

export async function runContainedReview(deps: ContainedReviewDeps): Promise<ContainedReviewResult> {
  const { engine, pr, runId } = deps;
  const execInLane = engine.execInLaneContainer?.bind(engine);
  if (!execInLane) {
    return { ok: false, error: 'container engine cannot exec into a lane container; refusing to run fork checkers' };
  }

  const removeLane = engine.removeLaneContainer?.bind(engine);
  if (!removeLane) {
    return { ok: false, error: 'container engine cannot remove a lane container; refusing to run fork checkers' };
  }

  const laneSlug = `review-pr-${pr.number}`;
  const name = laneContainerName(runId, laneSlug);
  let teardownPromise: Promise<LaneContainerRemoval> | undefined;
  const teardown = (): Promise<LaneContainerRemoval> =>
    (teardownPromise ??= removeLane(name).catch((err: unknown) => ({
      containerName: name,
      removed: false,
      evidence: `teardown error: ${err instanceof Error ? err.message : String(err)}`,
    })));

  const signals = deps.signals ?? process;
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const onSigint = (): void => void teardown().then(() => exit(130));
  const onSigterm = (): void => void teardown().then(() => exit(143));
  signals.once('SIGINT', onSigint);
  signals.once('SIGTERM', onSigterm);

  try {
    const result = await reviewInContainer(deps, execInLane, laneSlug);
    return { ...result, teardown: await teardown() };
  } catch (err) {
    await teardown();
    throw err;
  } finally {
    signals.removeListener('SIGINT', onSigint);
    signals.removeListener('SIGTERM', onSigterm);
  }
}

async function reviewInContainer(
  deps: ContainedReviewDeps,
  execInLane: NonNullable<ContainerEngine['execInLaneContainer']>,
  laneSlug: string,
): Promise<ContainedReviewResult> {
  const { engine, pr, runId } = deps;
  const provision = await provisionLaneContainer(
    engine,
    'disposable-docker',
    runId,
    laneSlug,
    pr.baseRepo,
    pullRequestHeadRef(pr.number),
  );
  const containerName = provision.containerName;
  if (!provision.created || !containerName) {
    return { ok: false, error: provision.error ?? 'container was not created', containerName };
  }
  if (provision.workspaceCloned !== true) {
    return { ok: false, error: `PR head clone failed: ${provision.workspaceError ?? 'unknown error'}`, containerName };
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec = async (command: readonly string[], limitMs: number): Promise<LaneExecResult> => {
    try {
      return await execInLane(containerName, command, { cwd: REPO_PATH, timeoutMs: limitMs });
    } catch (err) {
      return { exitCode: 1, output: err instanceof Error ? err.message : String(err), timedOut: false };
    }
  };

  const manifest = await exec(['cat', 'package.json'], READ_TIMEOUT_MS);
  const scripts: Record<string, string> | 'invalid' | null =
    manifest.exitCode === 0 ? scriptsFrom(manifest.output) : null;

  let installFailure: string | undefined;
  if (scripts && scripts !== 'invalid' && ['build', 'test', 'lint'].some((name) => scripts[name])) {
    const install = await exec(INSTALL_COMMAND, timeoutMs);
    if (install.timedOut) installFailure = `dependency install timed out after ${timeoutMs}ms`;
    else if (install.exitCode !== 0) installFailure = `dependency install failed: ${tail(install.output)}`;
  }

  const runScript = async (
    checker: string,
    scriptName: string,
    command: string[],
    missing: CheckerOutput,
  ): Promise<CheckerOutput> => {
    if (scripts === 'invalid') return { checker, result: 'FAIL', details: 'package.json is not valid JSON' };
    if (!scripts || !scripts[scriptName]) return missing;
    if (installFailure) return { checker, result: 'FAIL', details: installFailure };
    const label = command.join(' ');
    const r = await exec(command, timeoutMs);
    if (r.timedOut) return { checker, result: 'FAIL', details: `${label} timed out after ${timeoutMs}ms` };
    if (r.exitCode === 0) return { checker, result: 'PASS', details: `${label}: OK` };
    return { checker, result: 'FAIL', details: `${label} failed: ${tail(r.output)}` };
  };

  const results: CheckerOutput[] = [
    await runScript('compile', 'build', ['npm', 'run', 'build'], {
      checker: 'compile',
      result: 'SKIP',
      details: 'no build script',
    }),
    await runScript(
      'tests',
      'test',
      ['npm', 'test'],
      deps.testsRequired
        ? { checker: 'tests', result: 'FAIL', details: 'no test script but tests are required' }
        : { checker: 'tests', result: 'SKIP', details: 'no test script' },
    ),
    await runScript('lint', 'lint', ['npm', 'run', 'lint'], {
      checker: 'lint',
      result: 'SKIP',
      details: 'no lint script',
    }),
    { checker: 'links', result: 'SKIP', details: HOST_ONLY_SKIP },
    { checker: 'accessibility', result: 'SKIP', details: HOST_ONLY_SKIP },
  ];

  return { ok: true, summary: summarizeCheckerOutputs(results), containerName, commit: provision.workspaceCommit };
}
