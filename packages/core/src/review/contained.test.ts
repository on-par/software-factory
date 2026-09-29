import { describe, expect, it, vi } from 'vitest';

import { summarizeCheckerOutputs } from '../checkers/index.js';
import type { ContainerEngine, LaneExecOptions, LaneExecResult, LaneWorkspacePrepared } from '../hosted/container.js';
import { runContainmentGatedReview, type ReviewPullRequestRepos } from './containment.js';
import { pullRequestHeadRef, runContainedReview } from './contained.js';
import { computeReviewVerdict } from './verdict.js';

const fork: ReviewPullRequestRepos = { number: 8, baseRepo: 'acme/app', headRepo: 'mallory/app' };
const CONTAINER = 'sf-job-run-1-review-pr-8';

interface Script {
  packageJson?: string | null;
  exec?: (command: readonly string[]) => Partial<LaneExecResult> | undefined;
  createFails?: string;
  cloneFails?: string;
  prepareThrows?: string;
  execThrows?: string;
  noExec?: boolean;
}

function fakeEngine(script: Script = {}) {
  const packageJson =
    script.packageJson === undefined
      ? JSON.stringify({ scripts: { build: 'tsc', test: 'vitest', lint: 'oxlint' } })
      : script.packageJson;
  const created: string[] = [];
  const prepared: { containerName: string; repoSlug: string; ref?: string }[] = [];
  const execs: { command: readonly string[]; options: LaneExecOptions }[] = [];
  const engine: ContainerEngine = {
    prepareWorkspace: async () => {
      throw new Error('not used');
    },
    run: async () => {
      throw new Error('not used');
    },
    remove: async () => {
      throw new Error('not used');
    },
    async createLaneContainer(containerName) {
      created.push(containerName);
      if (script.createFails) throw new Error(script.createFails);
      return { containerName };
    },
    async prepareLaneWorkspace(containerName, repoSlug, ref): Promise<LaneWorkspacePrepared> {
      prepared.push({ containerName, repoSlug, ref });
      if (script.prepareThrows) throw new Error(script.prepareThrows);
      if (script.cloneFails) {
        return { containerRepoPath: '/workspace/repo', clone: { ok: false, error: script.cloneFails } };
      }
      return { containerRepoPath: '/workspace/repo', clone: { ok: true, commit: 'abc123' } };
    },
  };
  if (!script.noExec) {
    engine.execInLaneContainer = async (_name, command, options) => {
      execs.push({ command, options });
      if (script.execThrows) throw new Error(script.execThrows);
      const override = script.exec?.(command);
      if (override) return { exitCode: 0, output: '', timedOut: false, ...override };
      if (command[0] === 'cat') {
        return packageJson === null
          ? { exitCode: 1, output: 'No such file', timedOut: false }
          : { exitCode: 0, output: packageJson, timedOut: false };
      }
      return { exitCode: 0, output: 'ok', timedOut: false };
    };
  }
  return { engine, created, prepared, execs };
}

const argv = (execs: { command: readonly string[] }[]) => execs.map((e) => e.command.join(' '));

describe('pullRequestHeadRef', () => {
  it('builds the GitHub PR head ref', () => {
    expect(pullRequestHeadRef(12)).toBe('refs/pull/12/head');
  });
});

describe('runContainedReview', () => {
  it('provisions one container and clones the PR head ref from the base repo', async () => {
    const { engine, created, prepared } = fakeEngine();

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    expect(created).toEqual([CONTAINER]);
    expect(prepared).toEqual([{ containerName: CONTAINER, repoSlug: 'acme/app', ref: 'refs/pull/8/head' }]);
    expect(result).toMatchObject({ ok: true, containerName: CONTAINER, commit: 'abc123' });
  });

  it('runs every checker command through the container in /workspace/repo', async () => {
    const { engine, execs } = fakeEngine();

    await runContainedReview({ engine, pr: fork, runId: 'run-1', timeoutMs: 1234 });

    expect(argv(execs)).toEqual([
      'cat package.json',
      'sh -c if [ -f package-lock.json ]; then npm ci; else npm install; fi',
      'npm run build',
      'npm test',
      'npm run lint',
    ]);
    expect(execs.every((e) => e.options.cwd === '/workspace/repo')).toBe(true);
    expect(execs[2]?.options.timeoutMs).toBe(1234);
  });

  it('returns a CheckSummary shaped like runAllCheckers, in checker order', async () => {
    const { engine } = fakeEngine();

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    if (!result.ok) throw new Error(result.error);
    expect(result.summary.results.map((r) => r.checker)).toEqual([
      'compile',
      'tests',
      'lint',
      'links',
      'accessibility',
    ]);
    expect(result.summary).toEqual(summarizeCheckerOutputs(result.summary.results));
    expect(result.summary).toMatchObject({ failures: 0, passes: 3, skips: 2, total: 5 });
    expect(result.summary.results.slice(3).map((r) => r.details)).toEqual([
      'not run in a contained review (host-only checker)',
      'not run in a contained review (host-only checker)',
    ]);
  });

  it('feeds computeReviewVerdict: failing tests request changes, required host-only SKIPs cap at comments', async () => {
    const passing = await runContainedReview({ engine: fakeEngine().engine, pr: fork, runId: 'run-1' });
    const failingTests = await runContainedReview({
      engine: fakeEngine({ exec: (c) => (c.join(' ') === 'npm test' ? { exitCode: 1, output: 'boom' } : undefined) })
        .engine,
      pr: fork,
      runId: 'run-1',
    });
    if (!passing.ok || !failingTests.ok) throw new Error('expected ok');

    const base = { criteria: [], context: 'rich' as const };
    expect(computeReviewVerdict({ ...base, summary: passing.summary, requiredCheckers: [] }).verdict).toBe('approve');
    expect(computeReviewVerdict({ ...base, summary: passing.summary, requiredCheckers: ['links'] }).verdict).toBe(
      'approve with comments',
    );
    expect(computeReviewVerdict({ ...base, summary: failingTests.summary, requiredCheckers: [] }).verdict).toBe(
      'request changes',
    );
  });

  it('never runs the host review when driven through the containment gate', async () => {
    const { engine, execs } = fakeEngine();
    const runOnHost = vi.fn(async () => ({ exitCode: 0 }));
    const engineWithProbe: ContainerEngine = { ...engine, isAvailable: async () => true };

    const out = await runContainmentGatedReview({
      pr: fork,
      engine: engineWithProbe,
      runOnHost,
      write: vi.fn(),
      runContained: async () => {
        const r = await runContainedReview({ engine: engineWithProbe, pr: fork, runId: 'run-1' });
        return { exitCode: r.ok && r.summary.failures === 0 ? 0 : 1 };
      },
    });

    expect(out).toEqual({ exitCode: 0 });
    expect(runOnHost).not.toHaveBeenCalled();
    expect(execs.length).toBeGreaterThan(0);
  });

  it('SKIPs missing scripts and FAILs a missing test script when tests are required', async () => {
    const packageJson = JSON.stringify({ scripts: { lint: 'oxlint' } });

    const skipped = await runContainedReview({ engine: fakeEngine({ packageJson }).engine, pr: fork, runId: 'run-1' });
    const required = await runContainedReview({
      engine: fakeEngine({ packageJson }).engine,
      pr: fork,
      runId: 'run-1',
      testsRequired: true,
    });

    if (!skipped.ok || !required.ok) throw new Error('expected ok');
    expect(skipped.summary.results.slice(0, 3).map((r) => [r.result, r.details])).toEqual([
      ['SKIP', 'no build script'],
      ['SKIP', 'no test script'],
      ['PASS', 'npm run lint: OK'],
    ]);
    expect(required.summary.results[1]).toEqual({
      checker: 'tests',
      result: 'FAIL',
      details: 'no test script but tests are required',
    });
  });

  it('treats a package.json without a scripts object as no scripts and skips the install', async () => {
    const { engine, execs } = fakeEngine({ packageJson: JSON.stringify({ name: 'x' }) });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    if (!result.ok) throw new Error(result.error);
    expect(result.summary.results.slice(0, 3).map((r) => r.result)).toEqual(['SKIP', 'SKIP', 'SKIP']);
    expect(argv(execs)).toEqual(['cat package.json']);
  });

  it('SKIPs all command checkers and does not install when there is no package.json', async () => {
    const { engine, execs } = fakeEngine({ packageJson: null });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    if (!result.ok) throw new Error(result.error);
    expect(result.summary.results.slice(0, 3).map((r) => r.result)).toEqual(['SKIP', 'SKIP', 'SKIP']);
    expect(argv(execs)).toEqual(['cat package.json']);
  });

  it('FAILs every script-backed checker citing a failed dependency install', async () => {
    const { engine, execs } = fakeEngine({
      exec: (c) => (c[0] === 'sh' ? { exitCode: 1, output: 'ERESOLVE' } : undefined),
    });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    if (!result.ok) throw new Error(result.error);
    expect(result.summary.results.slice(0, 3).map((r) => r.result)).toEqual(['FAIL', 'FAIL', 'FAIL']);
    expect(result.summary.results[0]?.details).toBe('dependency install failed: ERESOLVE');
    expect(argv(execs)).toHaveLength(2);
  });

  it('FAILs citing an install timeout', async () => {
    const { engine } = fakeEngine({
      exec: (c) => (c[0] === 'sh' ? { exitCode: 1, timedOut: true } : undefined),
    });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1', timeoutMs: 50 });

    if (!result.ok) throw new Error(result.error);
    expect(result.summary.results[0]?.details).toBe('dependency install timed out after 50ms');
  });

  it('FAILs a checker whose command timed out, citing the timeout', async () => {
    const { engine } = fakeEngine({
      exec: (c) => (c.join(' ') === 'npm test' ? { exitCode: 1, timedOut: true } : undefined),
    });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1', timeoutMs: 50 });

    if (!result.ok) throw new Error(result.error);
    expect(result.summary.results[1]).toEqual({
      checker: 'tests',
      result: 'FAIL',
      details: 'npm test timed out after 50ms',
    });
  });

  it('FAILs a checker with a non-zero exit, citing the output tail', async () => {
    const { engine } = fakeEngine({
      exec: (c) => (c.join(' ') === 'npm run build' ? { exitCode: 2, output: 'x'.repeat(600) + 'TS2322' } : undefined),
    });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    if (!result.ok) throw new Error(result.error);
    const details = result.summary.results[0]?.details ?? '';
    expect(result.summary.results[0]?.result).toBe('FAIL');
    expect(details.startsWith('npm run build failed: ')).toBe(true);
    expect(details.endsWith('TS2322')).toBe(true);
    expect(details.length).toBe('npm run build failed: '.length + 500);
  });

  it('FAILs the command checkers on an invalid package.json', async () => {
    const { engine, execs } = fakeEngine({ packageJson: '{nope' });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    if (!result.ok) throw new Error(result.error);
    expect(result.summary.results.slice(0, 3).map((r) => [r.result, r.details])).toEqual(
      Array(3).fill(['FAIL', 'package.json is not valid JSON']),
    );
    expect(argv(execs)).toEqual(['cat package.json']);
  });

  it('treats a throwing exec as a failed command instead of crashing', async () => {
    const { engine } = fakeEngine({ execThrows: 'docker gone' });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    if (!result.ok) throw new Error(result.error);
    expect(result.summary.results.slice(0, 3).map((r) => r.result)).toEqual(['SKIP', 'SKIP', 'SKIP']);
  });

  it('turns a non-Error throw from exec into a FAIL detail', async () => {
    const { engine } = fakeEngine({ packageJson: JSON.stringify({ scripts: { test: 't' } }) });
    engine.execInLaneContainer = async (_n, command) => {
      if (command[0] === 'cat')
        return { exitCode: 0, output: JSON.stringify({ scripts: { test: 't' } }), timedOut: false };
      if (command[0] === 'sh') return { exitCode: 0, output: '', timedOut: false };
      throw 'plain string';
    };

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    if (!result.ok) throw new Error(result.error);
    expect(result.summary.results[1]).toEqual({
      checker: 'tests',
      result: 'FAIL',
      details: 'npm test failed: plain string',
    });
  });

  it('fails closed when the engine cannot exec, before creating anything', async () => {
    const { engine, created } = fakeEngine({ noExec: true });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    expect(result).toEqual({
      ok: false,
      error: 'container engine cannot exec into a lane container; refusing to run fork checkers',
    });
    expect(created).toEqual([]);
  });

  it('fails closed when the container cannot be created, running nothing', async () => {
    const { engine, execs, prepared } = fakeEngine({ createFails: 'docker not found' });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    expect(result).toEqual({ ok: false, error: 'docker not found', containerName: CONTAINER });
    expect(prepared).toEqual([]);
    expect(execs).toEqual([]);
  });

  it('fails closed when the PR head clone fails, running nothing', async () => {
    const { engine, execs } = fakeEngine({ cloneFails: "couldn't find remote ref" });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    expect(result).toEqual({
      ok: false,
      error: "PR head clone failed: couldn't find remote ref",
      containerName: CONTAINER,
    });
    expect(execs).toEqual([]);
  });

  it('fails closed when the workspace prepare throws', async () => {
    const { engine, execs } = fakeEngine({ prepareThrows: 'cp blew up' });

    const result = await runContainedReview({ engine, pr: fork, runId: 'run-1' });

    expect(result).toEqual({ ok: false, error: 'PR head clone failed: cp blew up', containerName: CONTAINER });
    expect(execs).toEqual([]);
  });
});
