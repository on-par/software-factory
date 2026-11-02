// packages/core/src/config/paths.test.ts — getFactoryPaths layout (split out of index.test.ts to stay under its max-lines ceiling).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { clearRepoSlugCache } from '../logger/repo-slug.js';
import { getFactoryPaths } from './index.js';

const tempDirs = createTempDirs();

describe('getFactoryPaths', () => {
  const expectedPaths = (root: string) => {
    const state = resolve(root, 'state');
    return {
      root,
      state,
      config: resolve(root, 'config.yaml'),
      queue: resolve(state, 'queue'),
      queueProposed: resolve(state, 'queue.proposed'),
      events: resolve(state, 'events.ndjson'),
      logs: resolve(state, 'logs'),
      plans: resolve(state, 'plans'),
      reports: resolve(state, 'reports'),
      runs: resolve(state, 'runs'),
      mergeLock: resolve(state, 'merge.lock'),
      gitLock: resolve(state, 'git.lock'),
      runLock: resolve(state, 'run.lock'),
      runLocks: resolve(state, 'locks', 'run'),
      product: resolve(state, 'product'),
      stop: resolve(state, 'STOP'),
      worktreeKeeps: resolve(state, 'worktree-keeps.json'),
      costs: resolve(state, 'costs.jsonl'),
      approvals: resolve(state, 'approvals'),
      steering: resolve(state, 'steering'),
      kpiHistory: resolve(state, 'kpi-history.jsonl'),
      kpiSweepCache: resolve(state, 'kpi-sweep-cache.json'),
      classifierOutcomes: resolve(state, 'classifier-outcomes.jsonl'),
      tierDemotions: resolve(state, 'tier-demotions.jsonl'),
      ingestWatermark: resolve(state, 'ingest-watermark'),
      ports: resolve(state, 'ports.json'),
      portsLock: resolve(state, 'ports.lock'),
      proxyState: resolve(state, 'proxy.json'),
      breaker: resolve(state, 'breaker.json'),
      reworkHistory: resolve(state, 'rework-history.json'),
      reviewRework: resolve(state, 'review-rework.json'),
      iterate: resolve(state, 'iterate.json'),
      baselineCache: resolve(state, 'baseline-cache.json'),
      readinessCache: resolve(state, 'readiness-cache'),
      baseHold: resolve(state, 'base-hold.json'),
      flakyLedger: resolve(state, 'flaky-tests.json'),
      laneFiles: resolve(state, 'lane-files.json'),
      runFlags: resolve(state, 'run-flags.json'),
      orphanDraftSweep: resolve(state, 'orphan-draft-sweep.json'),
    };
  };

  it('uses the repository-local state root by default', () => {
    const repoRoot = '/tmp/some-repo';
    expect(getFactoryPaths(repoRoot)).toEqual(expectedPaths(resolve(repoRoot, '.factory')));
  });

  describe('FACTORY_STATE_ROOT', () => {
    it('FACTORY_STATE_ROOT=auto roots every path under <home>/.factory/<owner>/<name> and none under the checkout', async () => {
      const repoRoot = await tempDirs.make('factory-state-root-auto-');
      try {
        await execa('git', ['init'], { cwd: repoRoot });
        await execa('git', ['remote', 'add', 'origin', 'git@github.com:o/n.git'], { cwd: repoRoot });
        clearRepoSlugCache();
        const paths = getFactoryPaths(repoRoot, undefined, { FACTORY_STATE_ROOT: 'auto' });
        expect(paths.root).toBe(join(homedir(), '.factory', 'o', 'n'));
        for (const p of Object.values(paths)) expect(p.startsWith(repoRoot)).toBe(false);
        expect(existsSync(join(repoRoot, '.factory'))).toBe(false);
      } finally {
        clearRepoSlugCache();
        await rm(repoRoot, { recursive: true, force: true });
      }
    });

    it('explicit stateRoot beats env', () => {
      expect(getFactoryPaths('/r', '/explicit', { FACTORY_STATE_ROOT: '/env' }).root).toBe('/explicit');
    });

    it('uses an absolute env value', () => {
      expect(getFactoryPaths('/r', undefined, { FACTORY_STATE_ROOT: '/env' }).root).toBe('/env');
    });

    it('blank FACTORY_STATE_ROOT is treated as unset', () => {
      expect(getFactoryPaths('/r', undefined, { FACTORY_STATE_ROOT: '  ' }).root).toBe(resolve('/r', '.factory'));
    });
  });

  it('keeps standalone queue, event, plan, and report artifacts beneath the checkout-local .factory/state directory', async () => {
    const repoRoot = await tempDirs.make('factory-standalone-state-');
    const paths = getFactoryPaths(repoRoot);
    const root = resolve(repoRoot, '.factory');
    const stateRoot = resolve(root, 'state');
    const artifacts = {
      queue: paths.queue,
      events: paths.events,
      plan: join(paths.plans, 'issue-845.md'),
      report: join(paths.reports, 'issue-845.md'),
    };

    try {
      await mkdir(paths.plans, { recursive: true });
      await mkdir(paths.reports, { recursive: true });
      await Promise.all(Object.entries(artifacts).map(async ([name, path]) => writeFile(path, `${name} artifact\n`)));

      await expect(readFile(artifacts.queue, 'utf8')).resolves.toBe('queue artifact\n');
      await expect(readFile(artifacts.events, 'utf8')).resolves.toBe('events artifact\n');
      await expect(readFile(artifacts.plan, 'utf8')).resolves.toBe('plan artifact\n');
      await expect(readFile(artifacts.report, 'utf8')).resolves.toBe('report artifact\n');
      expect(paths.root).toBe(root);
      expect(paths.state).toBe(stateRoot);
      expect(Object.values(artifacts).every((path) => path.startsWith(`${stateRoot}/`))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('uses an explicit external state root for every orchestration path', () => {
    const repoRoot = '/tmp/some-repo';
    const stateRoot = '/var/lib/factory-state/../factory-state';
    const paths = getFactoryPaths(repoRoot, stateRoot);
    expect(paths).toEqual(expectedPaths(resolve(stateRoot)));
    expect(paths.root).toBe(resolve(stateRoot));
    expect(paths.state).toBe(resolve(resolve(stateRoot), 'state'));
    expect(Object.values(paths).every((path) => !path.startsWith(resolve(repoRoot, '.factory')))).toBe(true);
  });

  it('resolves every runtime path under state/ while config stays at root', () => {
    const repoRoot = '/tmp/some-repo';
    const paths = getFactoryPaths(repoRoot);
    const runtimeKeys = [
      'ports',
      'portsLock',
      'proxyState',
      'breaker',
      'reworkHistory',
      'reviewRework',
      'iterate',
      'baselineCache',
      'readinessCache',
      'baseHold',
      'flakyLedger',
      'laneFiles',
      'runFlags',
      'orphanDraftSweep',
      'mergeLock',
      'gitLock',
      'runLock',
      'runLocks',
      'queue',
      'queueProposed',
      'events',
      'logs',
      'plans',
      'reports',
      'runs',
      'costs',
      'kpiHistory',
      'classifierOutcomes',
    ] as const;

    for (const key of runtimeKeys) expect(paths[key].startsWith(paths.state)).toBe(true);
    expect(paths.config.startsWith(paths.root)).toBe(true);
    expect(paths.config.startsWith(paths.state)).toBe(false);
  });

  it('roots every issue-named path field under the resolved base directory in both modes', () => {
    const repoRoot = '/tmp/some-repo';
    // Field groups the issue enumerates: config lives at root; the rest live under state.
    const rootRelativeKeys = ['config'] as const;
    const stateRelativeKeys = [
      'queue',
      'events',
      'costs',
      'plans',
      'reports',
      'breaker',
      'mergeLock',
      'gitLock',
      'runLock',
      'runLocks',
    ] as const;

    const assertRooted = (base: string) => {
      const paths =
        base === resolve(repoRoot, '.factory') ? getFactoryPaths(repoRoot) : getFactoryPaths(repoRoot, base);
      expect(paths.root).toBe(base);
      expect(paths.state).toBe(resolve(base, 'state'));
      for (const key of rootRelativeKeys) {
        expect(paths[key].startsWith(`${paths.root}/`)).toBe(true);
      }
      for (const key of stateRelativeKeys) {
        expect(paths[key].startsWith(`${paths.state}/`)).toBe(true);
      }
    };

    // Default mode: base is resolve(repoRoot, '.factory').
    assertRooted(resolve(repoRoot, '.factory'));
    // Explicit-stateRoot mode: base is an external resolved directory, and nothing leaks
    // back under the repo-local .factory.
    const stateRoot = resolve('/var/lib/factory-state');
    assertRooted(stateRoot);
    const explicit = getFactoryPaths(repoRoot, stateRoot);
    expect(
      [...rootRelativeKeys, ...stateRelativeKeys].every((k) => !explicit[k].startsWith(resolve(repoRoot, '.factory'))),
    ).toBe(true);
  });
});
