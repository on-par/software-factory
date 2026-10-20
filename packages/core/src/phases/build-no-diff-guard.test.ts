import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { collectDesignDiff } from '../checkers/design-smells.js';
import { buildPhase } from './build.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('buildPhase no-diff post-condition', () => {
  const fakeRouter = (output = 'done') =>
    ({
      run: async () => ({ model: 'fake-model', output, exitCode: 0, attempts: [] }),
    }) as any;

  it('fails the build when the diff collector reports an empty diff', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-961-empty.md');
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await buildPhase({
      issue: 961,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/961-no-diff',
      route: 'claude',
      router: fakeRouter(),
      constitution: null,
      log: (type, msg) => logs.push({ type, msg }),
      collectDiff: async () => ({ text: '', baseRef: 'origin/main', truncated: false }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_diff');
    const fail = logs.find((entry) => entry.type === 'fail')?.msg;
    expect(fail).toContain('worker produced no diff against origin/main; no implementation was produced');
    expect(fail).toContain('cause: unknown');
  });

  it('fails with no_diff when the slice has no changes beyond its parent base ref (#2717)', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-2717-empty.md');
    const logs: Array<{ type: string; msg: string }> = [];
    let receivedOpts: Parameters<typeof collectDesignDiff>[2];

    const result = await buildPhase({
      issue: 2717,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'factory/2717-slice-2',
      route: 'claude',
      router: fakeRouter(),
      constitution: null,
      log: (type, msg) => logs.push({ type, msg }),
      parentBaseRef: 'factory/2717-slice-1',
      captureBase: async () => 'presha',
      collectDiff: async (_wt, _run, opts) => {
        receivedOpts = opts;
        if (opts?.baseRefOverride === 'factory/2717-slice-1') {
          return { text: '', baseRef: opts.baseRefOverride, truncated: false };
        }
        return { text: 'diff --git a/parent b/parent', baseRef: 'origin/main', truncated: false };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_diff');
    expect(receivedOpts).toEqual({ fallbackBaseRef: 'presha', baseRefOverride: 'factory/2717-slice-1' });
    expect(logs.find((entry) => entry.type === 'fail')?.msg).toContain(
      'worker produced no diff against factory/2717-slice-1; no implementation was produced',
    );
  });

  it('does not pass baseRefOverride when no parentBaseRef is given (#2717)', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-2717-default.md');
    let receivedOpts: Parameters<typeof collectDesignDiff>[2];

    const result = await buildPhase({
      issue: 2717,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'factory/2717-default',
      route: 'claude',
      router: fakeRouter(),
      constitution: null,
      log: () => {},
      captureBase: async () => 'presha',
      collectDiff: async (_wt, _run, opts) => {
        receivedOpts = opts;
        return { text: 'diff --git a/x b/x', baseRef: 'origin/main', truncated: false };
      },
    });

    expect(result.ok).toBe(true);
    expect(receivedOpts).toBeDefined();
    expect('baseRefOverride' in (receivedOpts ?? {})).toBe(false);
  });

  it('fails with junk_only_diff when the filtered diff is empty but excluded paths exist', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-1162-junk.md');
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await buildPhase({
      issue: 1162,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/1162-junk-only',
      route: 'claude',
      router: fakeRouter('worker output for generated-only changes'),
      constitution: null,
      log: (type, msg) => logs.push({ type, msg }),
      collectDiff: async () => ({
        text: '',
        baseRef: 'abc123',
        truncated: false,
        excludedPaths: ['pkg/__pycache__/mod.cpython-311.pyc'],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('junk_only_diff');
    const fail = logs.find((l) => l.type === 'fail');
    expect(fail?.msg).toContain('only generated/cache files');
    expect(fail?.msg).toContain('pkg/__pycache__/mod.cpython-311.pyc');
    expect(fail?.msg).toContain('worker output for generated-only changes');
    expect(result.workerOutputTail).toBe('worker output for generated-only changes');
  });

  it('passes the captured pre-build base to the diff collector as fallbackBaseRef', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-1162-fallback.md');
    let receivedOpts: { fallbackBaseRef?: string } | undefined;

    const result = await buildPhase({
      issue: 1162,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/1162-fallback-base',
      route: 'claude',
      router: fakeRouter(),
      constitution: null,
      log: () => {},
      captureBase: async () => 'presha',
      collectDiff: async (_worktree, _run, opts) => {
        receivedOpts = opts;
        return { text: 'diff --git a/x b/x', baseRef: 'presha', truncated: false };
      },
    });

    expect(result.ok).toBe(true);
    expect(receivedOpts).toEqual({ fallbackBaseRef: 'presha' });
    expect(result.diffBase).toBe('presha');
  });

  it('succeeds when the diff collector reports a real diff', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-961-real.md');

    const result = await buildPhase({
      issue: 961,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/961-real-diff',
      route: 'claude',
      router: fakeRouter(),
      constitution: null,
      log: () => {},
      collectDiff: async () => ({ text: 'diff --git a/x b/x', baseRef: 'origin/main', truncated: false }),
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('passes when a real source change survives the junk filter (junk alongside real change)', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-1162-mixed.md');

    const result = await buildPhase({
      issue: 1162,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/1162-mixed-diff',
      route: 'claude',
      router: fakeRouter(),
      constitution: null,
      log: () => {},
      // The pycache churn is filtered out by DIFF_EXCLUDES; the surviving
      // source-file hunk is what makes the filtered text non-empty.
      collectDiff: async () => ({
        text: 'diff --git a/src/real.py b/src/real.py\n+implemented\n',
        baseRef: 'origin/main',
        truncated: false,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('treats an uncollectable diff (skipReason) as a pass, not a worker failure', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-961-skip.md');
    const logs: Array<{ type: string; msg: string }> = [];
    const skipReason = 'no base ref (tried origin/main, origin/master) — not a git checkout or no remote base';

    const result = await buildPhase({
      issue: 961,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/961-skip-reason',
      route: 'claude',
      router: fakeRouter(),
      constitution: null,
      log: (type, msg) => logs.push({ type, msg }),
      collectDiff: async () => ({ text: '', baseRef: null, truncated: false, skipReason }),
    });

    expect(result.ok).toBe(true);
    expect(logs.some((l) => l.msg.includes(skipReason))).toBe(true);
  });

  it('lets escalation win over no_diff and never calls the diff collector', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-961-escalate.md');
    let collectDiffCalled = false;

    const result = await buildPhase({
      issue: 961,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      branch: 'ship-it/961-escalate-wins',
      route: 'claude',
      router: fakeRouter('progress line\nESCALATE: the acceptance criteria are ambiguous\nmore text'),
      constitution: null,
      log: () => {},
      collectDiff: async () => {
        collectDiffCalled = true;
        return { text: '', baseRef: 'origin/main', truncated: false };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.escalate).toBe('ESCALATE: the acceptance criteria are ambiguous');
    expect(result.reason).not.toBe('no_diff');
    expect(collectDiffCalled).toBe(false);
  });
});
