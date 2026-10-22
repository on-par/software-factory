import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelDiagnosis } from '@on-par/factory-core';
import { getFactoryPaths, readPortLeases } from '@on-par/factory-core';
import type { GithubQueue } from '@on-par/factory-core/internal';
import { RunLockHeldError } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertValidProduct,
  CliExitError,
  errorDetail,
  formatDoctorReport,
  repoDefinedTag,
  modelStatusIcon,
  getCliVersion,
  hasReachableWorker,
  InvalidProductNameError,
  cmdFeedback,
  cmdFilingPreview,
  readOriginSlug,
  runFeedbackCommand,
  issueFromFactoryBranch,
  laneQueueDeps,
  LaneParkError,
  listOpenFactoryPRs,
  main,
  parkEvents,
  parkReasonFor,
  planRunLanes,
  tuiQueueReader,
  preflightQueuedIssue,
  HELP_FOOTER_TEXT,
  PREREQUISITES_TEXT,
  readActiveProduct,
  resolveEnvironmentAcquirer,
  resolveLaneBaseUrl,
  resolveUsageKnobs,
  sweepBetweenLaneIssues,
  scaffoldConstitution,
  startLaneProxy,
  sweepApprovedPRs,
  triageNoProposalError,
  triageProposalMessage,
  usageWatchSourceLabel,
  withRepoRunLock,
} from './cli/index.js';
// prettier-ignore
import { findOpenPRForIssue, isPermanentMergeCheckError, isPrMerged, MERGE_CHECK_FAILURE_BUDGET_MS, MERGE_CHECK_MAX_CONSECUTIVE_FAILURES, prLookupFailure, waitForMerge } from './cli/land.js';
// prettier-ignore
import { AwaitingReviewError, CiFailedError, CiInfraError, CiUnverifiedError, getPullRequestLandState, isHeadModifiedMergeError, isReviewRequiredMergeError, LandConflictError, LandFailureError, landOpenPullRequest, markPullRequestReady, squashMergeAndDelete } from './cli/land-pr.js';

describe('cli', () => {
  const originalFactoryMerge = process.env.FACTORY_MERGE;
  const originalFactoryMergeAdmin = process.env.FACTORY_MERGE_ADMIN;

  beforeEach(() => {
    delete process.env.FACTORY_MERGE;
    delete process.env.FACTORY_MERGE_ADMIN;
  });

  afterEach(() => {
    if (originalFactoryMerge === undefined) {
      delete process.env.FACTORY_MERGE;
    } else {
      process.env.FACTORY_MERGE = originalFactoryMerge;
    }
    if (originalFactoryMergeAdmin === undefined) {
      delete process.env.FACTORY_MERGE_ADMIN;
    } else {
      process.env.FACTORY_MERGE_ADMIN = originalFactoryMergeAdmin;
    }
  });

  it('exports the main entrypoint', () => {
    expect(typeof main).toBe('function');
  });

  it('formats the triage proposal message with an accept hint for non-empty content', () => {
    const message = triageProposalMessage(
      'lane-a 1\nlane-b 2\n',
      '/repo/.factory/queue.proposed',
      '/repo/.factory/queue',
    );
    expect(message).toContain('lane-a 1\nlane-b 2');
    expect(message).toContain('factory triage accept');
  });

  it('returns null for empty or whitespace-only triage proposals', () => {
    expect(triageProposalMessage('', '/repo/.factory/queue.proposed', '/repo/.factory/queue')).toBeNull();
    expect(triageProposalMessage('   \n  ', '/repo/.factory/queue.proposed', '/repo/.factory/queue')).toBeNull();
  });

  describe('errorDetail', () => {
    it('prefers a trimmed stderr string over message', () => {
      expect(errorDetail({ stderr: '  boom on stderr  \n', message: 'boom message' })).toBe('boom on stderr');
    });

    it('falls back to message when stderr is absent or empty', () => {
      expect(errorDetail({ message: 'boom message' })).toBe('boom message');
      expect(errorDetail({ stderr: '', message: 'boom message' })).toBe('boom message');
      expect(errorDetail({ stderr: '   ', message: 'boom message' })).toBe('boom message');
    });

    it('falls back to String(err) for non-Error values', () => {
      expect(errorDetail('boom')).toBe('boom');
      expect(errorDetail(null)).toBe('null');
      expect(errorDetail(undefined)).toBe('undefined');
    });
  });

  describe('triageNoProposalError', () => {
    it('includes the planner failure detail when a planner error is present', () => {
      const err = triageNoProposalError(new Error('claude: command not found'));
      expect(err.code).toBe(1);
      expect(err.message).toContain('triage produced no proposal');
      expect(err.message).toContain('planner failed: claude: command not found');
    });

    it('is exactly the base message when there is no planner error', () => {
      const err = triageNoProposalError(undefined);
      expect(err.code).toBe(1);
      expect(err.message).toBe('triage produced no proposal');
    });
  });

  describe('prLookupFailure', () => {
    it('returns a LandFailureError with code 5 and the issue/branch/detail in the message', () => {
      const err = prLookupFailure(42, 'ship-it/42-x', new Error('rate limited'));
      expect(err).toBeInstanceOf(LandFailureError);
      expect(err.code).toBe(5);
      expect(err.message).toContain('#42');
      expect(err.message).toContain('ship-it/42-x');
      expect(err.message).toContain('rate limited');
    });
  });

  it('resolves usage knobs from defaults', () => {
    expect(resolveUsageKnobs({})).toEqual({
      cap: 227,
      stopAt: 0.75,
      resumeAt: 0.65,
      pollMs: 180_000,
      watch: true,
      estimator: false,
      watchSource: 'default',
      stopAtSource: 'default',
      resumeAtSource: 'default',
      pollSource: 'default',
    });
  });

  it('resolves usage knobs from env overrides', () => {
    expect(
      resolveUsageKnobs({
        FACTORY_USAGE_CAP: '100',
        FACTORY_STOP_AT: '0.5',
        FACTORY_RESUME_AT: '0.4',
        FACTORY_USAGE_POLL: '60',
        FACTORY_USAGE_WATCH: '0',
        FACTORY_USAGE_ESTIMATOR: '1',
      }),
    ).toEqual({
      cap: 100,
      stopAt: 0.5,
      resumeAt: 0.4,
      pollMs: 60_000,
      watch: false,
      estimator: true,
      watchSource: 'env',
      stopAtSource: 'env',
      resumeAtSource: 'env',
      pollSource: 'env',
    });
  });

  it('usage-watch flag: resolveUsageKnobs reports the flag as the watch source', () => {
    expect(resolveUsageKnobs({ FACTORY_USAGE_WATCH: '0' }, null, { watch: true })).toMatchObject({
      watch: true,
      watchSource: 'flag',
    });
  });

  it('usage threshold and poll flags preserve their source metadata', () => {
    expect(
      resolveUsageKnobs({ FACTORY_STOP_AT: '0.5', FACTORY_RESUME_AT: '0.4', FACTORY_USAGE_POLL: '60' }, null, {
        stopAt: 0.7,
        resumeAt: 0.6,
        pollSeconds: 15,
      }),
    ).toMatchObject({
      stopAt: 0.7,
      resumeAt: 0.6,
      pollMs: 15_000,
      stopAtSource: 'flag',
      resumeAtSource: 'flag',
      pollSource: 'flag',
    });
  });

  it('usage-watch flag: usageWatchSourceLabel names each source', () => {
    expect(usageWatchSourceLabel('flag', false)).toBe('flag: --no-usage-watch');
    expect(usageWatchSourceLabel('flag', true)).toBe('flag: --usage-watch');
    expect(usageWatchSourceLabel('repo', true)).toBe('the repo config: budget.watchdog.watch');
    expect(usageWatchSourceLabel('env', false)).toBe('env: FACTORY_USAGE_WATCH');
    expect(usageWatchSourceLabel('default', true)).toBe('default');
  });

  it('defaults estimator to false for any value other than "1"', () => {
    expect(resolveUsageKnobs({ FACTORY_USAGE_ESTIMATOR: 'true' }).estimator).toBe(false);
    expect(resolveUsageKnobs({}).estimator).toBe(false);
  });

  it('rejects invalid usage knob values with env var names', () => {
    expect(() => resolveUsageKnobs({ FACTORY_USAGE_CAP: '-5' })).toThrow(/FACTORY_USAGE_CAP/);
    expect(() => resolveUsageKnobs({ FACTORY_STOP_AT: '1.5' })).toThrow(/FACTORY_STOP_AT/);
    expect(() => resolveUsageKnobs({ FACTORY_RESUME_AT: '1.5' })).toThrow(/FACTORY_RESUME_AT/);
    expect(() => resolveUsageKnobs({ FACTORY_USAGE_POLL: 'abc' })).toThrow(/FACTORY_USAGE_POLL/);
  });

  it('takes the repo config cap over FACTORY_USAGE_CAP when both are set', () => {
    expect(resolveUsageKnobs({ FACTORY_USAGE_CAP: '100' }, { version: 2, budget: { capUsd: 50 } }).cap).toBe(50);
  });

  it('falls back to FACTORY_USAGE_CAP when no repo config is passed', () => {
    expect(resolveUsageKnobs({ FACTORY_USAGE_CAP: '100' }, null).cap).toBe(100);
  });

  describe('startLaneProxy', () => {
    const settings = { enabled: true, port: 80, domain: 'factory.localhost' };
    let dir: string;
    let paths: any;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'cli-proxy-'));
      paths = {
        ports: join(dir, 'ports.json'),
        proxyState: join(dir, 'proxy.json'),
        events: join(dir, 'events.ndjson'),
      };
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('does nothing when the proxy feature is disabled', async () => {
      const events: any[] = [];
      const createProxy = vi.fn();
      const result = await startLaneProxy(
        paths,
        { ...settings, enabled: false },
        { createProxy, emitEvent: (...args: any[]) => events.push(args) },
      );

      expect(result.proxy).toBeUndefined();
      expect(createProxy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it('starts the proxy, writes proxy state, and emits exactly one environment_proxy event on success', async () => {
      const events: any[] = [];
      const stubProxy = { server: {} as any, port: 80, start: async () => 80, stop: async () => {} };
      const createProxy = vi.fn(() => stubProxy);

      const result = await startLaneProxy(paths, settings, {
        createProxy,
        emitEvent: (...args: any[]) => events.push(args),
      });

      expect(result.proxy).toBe(stubProxy);
      expect(createProxy).toHaveBeenCalledWith({
        registryFile: paths.ports,
        domain: 'factory.localhost',
        port: 80,
      });
      expect(events).toEqual([
        [paths.events, 'environment_proxy', 'all', expect.stringContaining('lane proxy listening on 127.0.0.1:80')],
      ]);
    });

    it('emits exactly one environment_proxy_unavailable event and returns no proxy when start() rejects', async () => {
      const events: any[] = [];
      const stubProxy = {
        server: {} as any,
        port: 80,
        start: async () => {
          throw new Error('EACCES: permission denied');
        },
        stop: async () => {},
      };
      const createProxy = vi.fn(() => stubProxy);

      const result = await startLaneProxy(paths, settings, {
        createProxy,
        emitEvent: (...args: any[]) => events.push(args),
      });

      expect(result.proxy).toBeUndefined();
      expect(events).toEqual([
        [
          paths.events,
          'environment_proxy_unavailable',
          'all',
          expect.stringContaining('proxy unavailable (EACCES: permission denied)'),
        ],
      ]);
    });
  });

  describe('resolveLaneBaseUrl', () => {
    const paths = { proxyState: '/repo/.factory/proxy.json' } as any;
    const settings = { enabled: true, port: 80, domain: 'factory.localhost' };

    it('returns an empty note when the proxy feature is disabled', () => {
      const result = resolveLaneBaseUrl(paths, { ...settings, enabled: false }, '/repo/ship-it-1', 3142, {
        isRunning: () => ({ version: 1, pid: 1, port: 80, domain: 'factory.localhost', startedAt: 'now' }),
      });
      expect(result).toEqual({ note: '' });
    });

    it('returns an empty note when there is no leased appPort', () => {
      const result = resolveLaneBaseUrl(paths, settings, '/repo/ship-it-1', undefined, {
        isRunning: () => ({ version: 1, pid: 1, port: 80, domain: 'factory.localhost', startedAt: 'now' }),
      });
      expect(result).toEqual({ note: '' });
    });

    it('returns the stable lane URL when a matching-domain proxy is alive', () => {
      const result = resolveLaneBaseUrl(paths, settings, '/repo/ship-it-1', 3142, {
        isRunning: () => ({ version: 1, pid: 1, port: 80, domain: 'factory.localhost', startedAt: 'now' }),
      });
      expect(result.baseUrl).toBe('http://ship-it-1.factory.localhost');
      expect(result.note).toContain('http://ship-it-1.factory.localhost');
    });

    it('returns a port-based note (no baseUrl) when the proxy is not running', () => {
      const result = resolveLaneBaseUrl(paths, settings, '/repo/ship-it-1', 3142, { isRunning: () => undefined });
      expect(result.baseUrl).toBeUndefined();
      expect(result.note).toContain('http://127.0.0.1:3142');
    });

    it('returns a port-based note (no baseUrl) when the running proxy is on a different domain', () => {
      const result = resolveLaneBaseUrl(paths, settings, '/repo/ship-it-1', 3142, {
        isRunning: () => ({ version: 1, pid: 1, port: 80, domain: 'other.localhost', startedAt: 'now' }),
      });
      expect(result.baseUrl).toBeUndefined();
      expect(result.note).toContain('http://127.0.0.1:3142');
    });
  });

  describe('resolveEnvironmentAcquirer', () => {
    let dir: string;
    let paths: any;
    const baseOpts = (overrides: Partial<Parameters<typeof resolveEnvironmentAcquirer>[0]> = {}) => ({
      laneSandboxRuntime: 'none' as const,
      paths,
      worktree: '/repo/.worktrees/654',
      branch: 'ship-it/654',
      range: [4000, 4999] as [number, number],
      processGroupGraceMs: 1000,
      log: vi.fn(),
      ...overrides,
    });

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'cli-env-acquirer-'));
      paths = { ports: join(dir, 'ports.json'), portsLock: join(dir, 'ports.lock') };
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('returns undefined and logs a skip for a docker-sandbox lane, never reaching acquirePortLease', () => {
      const log = vi.fn();

      const acquirer = resolveEnvironmentAcquirer(
        baseOpts({ laneSandboxRuntime: 'docker-sandbox', worktree: '/repo/.worktrees/654', log }),
      );

      expect(acquirer).toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        'environment_lease',
        expect.stringContaining('docker-sandbox lane /repo/.worktrees/654 binds its port inside its own microVM'),
      );
      expect(readPortLeases(paths.ports)).toEqual([]);
    });

    it('returns an acquirer function for non-docker-sandbox runtimes', () => {
      for (const laneSandboxRuntime of ['sandbox-exec', 'none'] as const) {
        const acquirer = resolveEnvironmentAcquirer(baseOpts({ laneSandboxRuntime }));
        expect(typeof acquirer).toBe('function');
      }
    });

    it('leaves .factory/ports.json with no entries for either of two concurrent docker-sandbox lanes', () => {
      const acquirerA = resolveEnvironmentAcquirer(
        baseOpts({ laneSandboxRuntime: 'docker-sandbox', worktree: '/repo/.worktrees/654a' }),
      );
      const acquirerB = resolveEnvironmentAcquirer(
        baseOpts({ laneSandboxRuntime: 'docker-sandbox', worktree: '/repo/.worktrees/654b' }),
      );

      expect(acquirerA).toBeUndefined();
      expect(acquirerB).toBeUndefined();
      expect(readPortLeases(paths.ports)).toEqual([]);
    });
  });

  it('detects a merge by head branch even when it is outside the recent-closed window', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          list: async ({ head }: any) =>
            head === 'on-par:ship-it/22-x' ? { data: [{ merged_at: '2026-01-01T00:00:00Z' }] } : { data: [] },
        },
      },
    };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/22-x')).toBe(true);
  });

  it('returns false when the head branch has no merged PR', async () => {
    const octokit: any = { rest: { pulls: { list: async () => ({ data: [{ merged_at: null }] }) } } };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/22-x')).toBe(false);
  });

  it('does not report a fresh, still-open PR as merged when an older PR reused the same branch name', async () => {
    // Regression for the debt-lane regression: a verify-and-close pass
    // recreates the exact head branch an earlier, already-merged PR used.
    // The old logic ("was ANY closed PR ever merged under this branch")
    // matched the stale #41 and made waitForMerge believe #44 had landed
    // while #44 sat open forever.
    const octokit: any = {
      rest: {
        pulls: {
          list: async ({ head }: any) =>
            head === 'on-par:ship-it/28-x'
              ? {
                  data: [
                    { number: 41, merged_at: '2026-08-10T00:00:00Z' },
                    { number: 44, merged_at: null },
                  ],
                }
              : { data: [] },
        },
      },
    };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/28-x')).toBe(false);
  });

  it('reports the reused branch merged once the newest PR under it is the one that landed', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              { number: 41, merged_at: '2026-08-10T00:00:00Z' },
              { number: 44, merged_at: '2026-08-14T00:00:00Z' },
            ],
          }),
        },
      },
    };
    expect(await isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/28-x')).toBe(true);
  });

  it('propagates API failures from isPrMerged instead of treating them as not-merged', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          list: async () => {
            throw new Error('rate limited');
          },
        },
      },
    };
    await expect(isPrMerged(octokit, 'on-par', 'software-factory', 'ship-it/22-x')).rejects.toThrow('rate limited');
  });

  it('falls back to matching the open PR that references the issue in its body', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              {
                number: 1,
                body: 'Closes #7',
                head: { ref: 'ship-it/1-unrelated', sha: 'sha-1', repo: { full_name: 'on-par/software-factory' } },
              },
              {
                number: 42,
                body: 'Fixes some things.\n\nCloses #19',
                head: {
                  ref: 'ship-it/19-renamed-title',
                  sha: 'sha-42',
                  repo: { full_name: 'on-par/software-factory' },
                },
              },
            ],
          }),
        },
      },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toEqual({
      number: 42,
      branch: 'ship-it/19-renamed-title',
      headSha: 'sha-42',
      headRepoFullName: 'on-par/software-factory',
    });
  });

  it('returns undefined from the issue-body fallback when no open PR references the issue', async () => {
    const octokit: any = {
      rest: { pulls: { list: async () => ({ data: [{ number: 1, body: 'Closes #7', head: { ref: 'x' } }] }) } },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toBeUndefined();
  });

  it('propagates API failures from findOpenPRForIssue instead of treating them as no-match', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          list: async () => {
            throw new Error('rate limited');
          },
        },
      },
    };
    await expect(findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).rejects.toThrow('rate limited');
  });

  it('paginates the issue-body fallback to find a match beyond the first page', async () => {
    const calledPages: number[] = [];
    const octokit: any = {
      rest: {
        pulls: {
          list: async ({ page }: any) => {
            calledPages.push(page);
            if (page === 1) {
              return {
                data: Array.from({ length: 100 }, (_, i) => ({
                  number: i + 1,
                  body: 'Closes #7',
                  head: { ref: `ship-it/${i + 1}-unrelated` },
                })),
              };
            }
            if (page === 2) {
              return {
                data: Array.from({ length: 30 }, (_, i) => {
                  if (i === 19) {
                    return {
                      number: 999,
                      body: 'Closes #19',
                      head: {
                        ref: 'ship-it/19-renamed-title',
                        sha: 'sha-999',
                        repo: { full_name: 'on-par/software-factory' },
                      },
                    };
                  }
                  return { number: 100 + i + 1, body: 'Closes #7', head: { ref: `ship-it/${100 + i + 1}-unrelated` } };
                }),
              };
            }
            return { data: [] };
          },
        },
      },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toEqual({
      number: 999,
      branch: 'ship-it/19-renamed-title',
      headSha: 'sha-999',
      headRepoFullName: 'on-par/software-factory',
    });
    expect(calledPages).toEqual([1, 2]);
  });

  it('paginates through every page and returns undefined when no page matches', async () => {
    const calledPages: number[] = [];
    const octokit: any = {
      rest: {
        pulls: {
          list: async ({ page }: any) => {
            calledPages.push(page);
            if (page === 1 || page === 2) {
              return {
                data: Array.from({ length: 100 }, (_, i) => ({
                  number: (page - 1) * 100 + i + 1,
                  body: 'Closes #7',
                  head: { ref: `ship-it/${(page - 1) * 100 + i + 1}-unrelated` },
                })),
              };
            }
            return { data: [] };
          },
        },
      },
    };

    expect(await findOpenPRForIssue(octokit, 'on-par', 'software-factory', 19)).toBeUndefined();
    expect(calledPages).toEqual([1, 2, 3]);
  });

  const fakeFactoryConfig = (auto: boolean): any => ({
    merge: { auto, comment: '' },
    ci: { skip: false, comment: '' },
    filing: {
      enabled: true,
      excludeReasons: ['rate_limit', 'usage_cap', 'timeout', 'verify_failed'],
      repeatThreshold: 3,
      maxPerRun: 5,
      maxPerDay: 20,
      selfFixLabel: 'no-auto-merge',
      bugLabels: ['bug'],
      sensitivePaths: ['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'],
    },
  });

  it('bumps the per-issue phase-snapshot heartbeat on every merge-wait poll (#1369)', async () => {
    const core = await import('@on-par/factory-core');
    const root = await mkdtemp(join(tmpdir(), 'wait-for-merge-'));
    const runs = join(root, 'runs');
    const file = core.phaseSnapshotFile(runs, 21);
    await core.writePhaseSnapshot(file, {
      issue: 21,
      phase: 'ship',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    });
    const paths: any = { events: join(root, 'events.ndjson'), stop: join(root, 'STOP'), runs };
    let polls = 0;

    await waitForMerge(21, 'ship-it/21-heartbeat', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => false,
      checkMerged: async () => {
        polls += 1;
        return polls >= 2;
      },
      loadConfig: () => fakeFactoryConfig(false),
      listIssueLabels: async () => [],
      land: async () => ({ branch: 'ship-it/21-heartbeat', prNumber: 1 }),
      emitEvent: () => {},
      sleep: async () => {},
    });

    await vi.waitFor(async () => {
      const after = await core.readPhaseSnapshot(file);
      expect(Date.parse(after?.lastActivityAt ?? '')).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
      expect(after?.phase).toBe('ship');
    });
    await rm(root, { recursive: true, force: true });
  });

  it('self-merges a ready PR when merge is enabled via config', async () => {
    const calls: any[] = [];
    const octokit: any = {};
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => octokit,
      pathExists: () => false,
      checkMerged: async (...args: any[]) => {
        calls.push(['checkMerged', args]);
        return false;
      },
      loadConfig: () => {
        calls.push(['loadConfig']);
        return fakeFactoryConfig(true);
      },
      listIssueLabels: async (...args: any[]) => {
        calls.push(['listIssueLabels', args]);
        return ['bug'];
      },
      land: async (...args: any[]) => {
        calls.push(['land', args]);
        return { branch: 'ship-it/21-self-merge', prNumber: 321 };
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
      sleep: async () => {
        calls.push(['sleep']);
      },
    });

    expect(calls).toEqual([
      ['loadConfig'],
      ['event', 'await-merge', 21, 'waiting to merge ship-it/21-self-merge'],
      ['checkMerged', [octokit, 'on-par', 'software-factory', 'ship-it/21-self-merge']],
      ['listIssueLabels', [octokit, 'on-par', 'software-factory', 21]],
      ['land', [21, '/repo', 'on-par/software-factory', paths, octokit, false, undefined, { enforceRisk: true }]],
    ]);
  });

  it('self-merges via .factory/config.json merge.auto with FACTORY_MERGE unset', async () => {
    const calls: any[] = [];
    const octokit: any = {};
    const paths: any = {
      events: '/repo/.factory/events.ndjson',
      stop: '/repo/.factory/STOP',
      config: '/repo/.factory/config.json',
    };

    expect(process.env.FACTORY_MERGE).toBeUndefined();

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => octokit,
      pathExists: () => false,
      checkMerged: async () => false,
      loadConfig: (configPath: string) => {
        calls.push(['loadConfig', configPath]);
        return fakeFactoryConfig(true);
      },
      listIssueLabels: async () => ['bug'],
      land: async (...args: any[]) => {
        calls.push(['land', args]);
        return { branch: 'ship-it/21-self-merge', prNumber: 321 };
      },
      emitEvent: () => {},
      sleep: async () => {},
    });

    expect(calls).toContainEqual(['loadConfig', '/repo/.factory/config.json']);
    expect(calls.some((call) => call[0] === 'land')).toBe(true);
  });

  it('does not self-merge when run.merge.auto is explicitly false, even with FACTORY_MERGE=1 set (deliberate behavior change)', async () => {
    const calls: any[] = [];
    const octokit: any = {};
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    process.env.FACTORY_MERGE = '1';
    let stopped = false;

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => octokit,
      pathExists: () => stopped,
      checkMerged: async () => false,
      loadConfig: () => ({ ...fakeFactoryConfig(false), run: { merge: { auto: false } } }),
      listIssueLabels: async () => {
        throw new Error('listIssueLabels should not be called — merge is disabled');
      },
      land: async () => {
        throw new Error('land should not be called — run.merge.auto: false must win over FACTORY_MERGE=1');
      },
      emitEvent: () => {},
      writeLine: (line) => calls.push(line),
      sleep: async () => {
        stopped = true;
      },
    });

    expect(calls).toContainEqual('[factory] #21 awaiting human merge (poll 120s)');
  });

  it('auto-merge flag: mergeOverrides.auto true merges even when run.merge.auto is false', async () => {
    const octokit: any = {};
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let landCalled = false;

    await waitForMerge(21, 'ship-it/21-flag-true', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => octokit,
      pathExists: () => false,
      checkMerged: async () => false,
      loadConfig: () => ({ ...fakeFactoryConfig(false), run: { merge: { auto: false } } }),
      mergeOverrides: { auto: true },
      listIssueLabels: async () => [],
      land: async () => {
        landCalled = true;
        return { branch: 'ship-it/21-flag-true', prNumber: 321 };
      },
      emitEvent: () => {},
      sleep: async () => {},
    });

    expect(landCalled).toBe(true);
  });

  it('auto-merge flag: mergeOverrides.auto false blocks merge even with FACTORY_MERGE=1 and run.merge.auto true', async () => {
    const calls: any[] = [];
    const octokit: any = {};
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    process.env.FACTORY_MERGE = '1';
    let stopped = false;

    await waitForMerge(21, 'ship-it/21-flag-false', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => octokit,
      pathExists: () => stopped,
      checkMerged: async () => false,
      loadConfig: () => ({ ...fakeFactoryConfig(false), run: { merge: { auto: true } } }),
      mergeOverrides: { auto: false },
      listIssueLabels: async () => {
        throw new Error('listIssueLabels should not be called — merge is disabled by the flag');
      },
      land: async () => {
        throw new Error('land should not be called — mergeOverrides.auto: false must win');
      },
      emitEvent: () => {},
      writeLine: (line) => calls.push(line),
      sleep: async () => {
        stopped = true;
      },
    });

    expect(calls).toContainEqual('[factory] #21 awaiting human merge (poll 120s)');
  });

  it('falls back to the GitHub API for issue labels when no listIssueLabels override is provided', async () => {
    const calls: any[] = [];
    const octokit: any = {
      rest: {
        issues: {
          listLabelsOnIssue: async (...args: any[]) => {
            calls.push(['listLabelsOnIssue', args]);
            return { data: [{ name: 'bug' }, { name: 'priority' }] };
          },
        },
      },
    };
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => octokit,
      pathExists: () => false,
      checkMerged: async () => false,
      loadConfig: () => fakeFactoryConfig(true),
      land: async (...args: any[]) => {
        calls.push(['land', args]);
        return { branch: 'ship-it/21-self-merge', prNumber: 321 };
      },
      emitEvent: () => {},
      sleep: async () => {
        throw new Error('sleep should not be called');
      },
    });

    expect(calls).toEqual([
      ['listLabelsOnIssue', [{ owner: 'on-par', repo: 'software-factory', issue_number: 21 }]],
      ['land', [21, '/repo', 'on-par/software-factory', paths, octokit, false, undefined, { enforceRisk: true }]],
    ]);
  });

  it('gates auto-merge behind the no-auto-merge label and keeps polling', async () => {
    const calls: any[] = [];
    const octokit: any = {};
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let stopped = false;

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => octokit,
      pathExists: () => stopped,
      checkMerged: async () => false,
      loadConfig: () => fakeFactoryConfig(true),
      listIssueLabels: async () => ['bug', 'no-auto-merge'],
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
      writeLine: (line) => calls.push(['writeLine', line]),
      sleep: async (ms) => {
        calls.push(['sleep', ms]);
        stopped = true;
      },
    });

    expect(calls).toContainEqual([
      'event',
      'merge-gated',
      21,
      'auto-merge blocked by no-auto-merge — awaiting human approval',
    ]);
    expect(calls).toContainEqual([
      'writeLine',
      '[factory] #21 auto-merge gated (no-auto-merge); awaiting human merge (poll 120s)',
    ]);
    expect(calls).toContainEqual(['sleep', 120_000]);
  });

  it('treats a failed label check as blocked and does not auto-merge (fail-safe)', async () => {
    const calls: any[] = [];
    const octokit: any = {};
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let stopped = false;

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => octokit,
      pathExists: () => stopped,
      checkMerged: async () => false,
      loadConfig: () => fakeFactoryConfig(true),
      listIssueLabels: async () => {
        throw new Error('label lookup failed');
      },
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
      writeLine: (line) => calls.push(['writeLine', line]),
      sleep: async (ms) => {
        calls.push(['sleep', ms]);
        stopped = true;
      },
    });

    const warnEvent = calls.find((c) => c[0] === 'event' && c[1] === 'warn');
    expect(warnEvent).toBeDefined();
    expect(warnEvent[3]).toContain('label check failed');
    expect(calls).toContainEqual([
      'event',
      'merge-gated',
      21,
      'auto-merge blocked by no-auto-merge — awaiting human approval',
    ]);
  });

  it('propagates an AwaitingReviewError from land unchanged instead of swallowing it', async () => {
    const calls: any[] = [];
    const octokit: any = {};
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    const awaitingReviewError = new AwaitingReviewError('PR #101 awaiting review', 101);

    await expect(
      waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
        createOctokit: () => octokit,
        pathExists: () => false,
        checkMerged: async () => false,
        loadConfig: () => fakeFactoryConfig(true),
        listIssueLabels: async () => ['bug'],
        land: async () => {
          throw awaitingReviewError;
        },
        emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
          calls.push(['event', type, issue, msg]),
        sleep: async () => {
          throw new Error('sleep should not be called');
        },
      }),
    ).rejects.toBe(awaitingReviewError);

    expect(calls).toEqual([['event', 'await-merge', 21, 'waiting to merge ship-it/21-self-merge']]);
  });

  it('returns immediately and logs a landed event once checkMerged reports the PR merged', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => false,
      checkMerged: async () => true,
      loadConfig: () => fakeFactoryConfig(false),
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
      sleep: async () => {
        throw new Error('sleep should not be called');
      },
    });

    expect(calls).toEqual([
      ['event', 'await-merge', 21, 'waiting to merge ship-it/21-self-merge'],
      ['event', 'landed', 21, 'PR merged'],
    ]);
  });

  it('defaults to review mode and polls without merging', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let stopped = false;

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => stopped,
      checkMerged: async () => {
        calls.push(['checkMerged']);
        return false;
      },
      loadConfig: () => fakeFactoryConfig(false),
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
      writeLine: (line) => calls.push(['writeLine', line]),
      sleep: async (ms) => {
        calls.push(['sleep', ms]);
        stopped = true;
      },
    });

    expect(calls).toEqual([
      ['event', 'await-merge', 21, 'waiting to merge ship-it/21-self-merge'],
      ['checkMerged'],
      ['writeLine', '[factory] #21 awaiting human merge (poll 120s)'],
      ['sleep', 120_000],
    ]);
  });

  it('records a failed merged-state check as a warn event and keeps polling instead of crashing', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let stopped = false;

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => stopped,
      checkMerged: async () => {
        throw new Error('rate limited');
      },
      loadConfig: () => fakeFactoryConfig(false),
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
      writeLine: (line) => calls.push(['writeLine', line]),
      sleep: async (ms) => {
        calls.push(['sleep', ms]);
        stopped = true;
      },
    });

    const warnEvent = calls.find((c) => c[0] === 'event' && c[1] === 'warn');
    expect(warnEvent).toBeDefined();
    expect(warnEvent[2]).toBe(21);
    expect(warnEvent[3]).toContain('merged-state check failed');
    expect(warnEvent[3]).toContain('rate limited');

    expect(calls).toContainEqual(['event', 'await-merge', 21, 'waiting to merge ship-it/21-self-merge']);
    expect(calls).toContainEqual(['writeLine', '[factory] #21 awaiting human merge (poll 120s)']);
    expect(calls).toContainEqual(['sleep', 120_000]);
  });

  it('does not escalate a transient merged-state failure that recovers on the next poll', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let attempt = 0;

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => false,
      checkMerged: async () => {
        attempt++;
        if (attempt === 1) throw new Error('rate limited');
        return true;
      },
      loadConfig: () => fakeFactoryConfig(false),
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
      writeLine: (line) => calls.push(['writeLine', line]),
      sleep: async () => {
        calls.push(['sleep']);
      },
    });

    expect(calls.some((c) => c[0] === 'event' && c[1] === 'warn')).toBe(true);
    expect(calls.some((c) => c[0] === 'event' && c[1] === 'escalate')).toBe(false);
    expect(calls).toContainEqual(['event', 'landed', 21, 'PR merged']);
  });

  it('resets the failure streak on any successful merged-state check so it never escalates', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    const totalAttempts = 2 * MERGE_CHECK_MAX_CONSECUTIVE_FAILURES + 5;
    let attempt = 0;
    let stopped = false;

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => stopped,
      checkMerged: async () => {
        attempt++;
        if (attempt >= totalAttempts) stopped = true;
        if (attempt % 2 === 0) throw new Error('blip');
        return false;
      },
      loadConfig: () => fakeFactoryConfig(false),
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
      writeLine: () => {},
      sleep: async () => {},
    });

    expect(calls.some((c) => c[0] === 'event' && c[1] === 'escalate')).toBe(false);
  });

  it('parks the lane once consecutive failures reach the streak threshold', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let checkMergedCalls = 0;

    await expect(
      waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
        createOctokit: () => ({}) as any,
        pathExists: () => false,
        checkMerged: async () => {
          checkMergedCalls++;
          throw new Error('boom');
        },
        loadConfig: () => fakeFactoryConfig(false),
        land: async () => {
          throw new Error('land should not be called');
        },
        emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
          calls.push(['event', type, issue, msg]),
        writeLine: () => {},
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ reason: 'escalate' });

    expect(checkMergedCalls).toBe(MERGE_CHECK_MAX_CONSECUTIVE_FAILURES);
    const escalateEvents = calls.filter((c) => c[0] === 'event' && c[1] === 'escalate');
    expect(escalateEvents).toHaveLength(1);
    expect(escalateEvents[0][3]).toContain('boom');
    expect(escalateEvents[0][3]).toContain('ship-it/21-self-merge');
  });

  it('parks the lane once the wall-clock failure budget is spent, even under the streak threshold', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let checkMergedCalls = 0;
    let nowCalls = 0;

    await expect(
      waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
        createOctokit: () => ({}) as any,
        pathExists: () => false,
        checkMerged: async () => {
          checkMergedCalls++;
          throw new Error('boom');
        },
        loadConfig: () => fakeFactoryConfig(false),
        land: async () => {
          throw new Error('land should not be called');
        },
        emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
          calls.push(['event', type, issue, msg]),
        writeLine: () => {},
        sleep: async () => {},
        now: () => {
          nowCalls++;
          return nowCalls === 1 ? 0 : MERGE_CHECK_FAILURE_BUDGET_MS;
        },
      }),
    ).rejects.toMatchObject({ reason: 'escalate' });

    expect(checkMergedCalls).toBeLessThan(MERGE_CHECK_MAX_CONSECUTIVE_FAILURES);
    const escalateEvents = calls.filter((c) => c[0] === 'event' && c[1] === 'escalate');
    expect(escalateEvents).toHaveLength(1);
    expect(escalateEvents[0][3]).toContain('boom');
  });

  it('parks the lane immediately on a 401 without waiting out the streak or budget', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let checkMergedCalls = 0;

    await expect(
      waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
        createOctokit: () => ({}) as any,
        pathExists: () => false,
        checkMerged: async () => {
          checkMergedCalls++;
          throw Object.assign(new Error('Bad credentials'), { status: 401 });
        },
        loadConfig: () => fakeFactoryConfig(false),
        land: async () => {
          throw new Error('land should not be called');
        },
        emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
          calls.push(['event', type, issue, msg]),
        writeLine: () => {},
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ reason: 'escalate' });

    expect(checkMergedCalls).toBe(1);
    const escalateEvents = calls.filter((c) => c[0] === 'event' && c[1] === 'escalate');
    expect(escalateEvents).toHaveLength(1);
    expect(escalateEvents[0][3]).toContain('Bad credentials');
    const warnIndex = calls.findIndex((c) => c[0] === 'event' && c[1] === 'warn');
    const escalateIndex = calls.findIndex((c) => c[0] === 'event' && c[1] === 'escalate');
    expect(warnIndex).toBeGreaterThanOrEqual(0);
    expect(warnIndex).toBeLessThan(escalateIndex);
  });

  it('parks the lane immediately on a 403 with no rate-limit evidence', async () => {
    const calls: any[] = [];
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let checkMergedCalls = 0;

    await expect(
      waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
        createOctokit: () => ({}) as any,
        pathExists: () => false,
        checkMerged: async () => {
          checkMergedCalls++;
          throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
        },
        loadConfig: () => fakeFactoryConfig(false),
        land: async () => {
          throw new Error('land should not be called');
        },
        emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
          calls.push(['event', type, issue, msg]),
        writeLine: () => {},
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ reason: 'escalate' });

    expect(checkMergedCalls).toBe(1);
    expect(calls.filter((c) => c[0] === 'event' && c[1] === 'escalate')).toHaveLength(1);
  });

  it('treats a rate-limited 403 as transient and keeps polling instead of parking', async () => {
    const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
    let stopped = false;
    const calls: any[] = [];

    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => stopped,
      checkMerged: async () => {
        stopped = true;
        throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
      },
      loadConfig: () => fakeFactoryConfig(false),
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls.push(['event', type, issue, msg]),
      writeLine: () => {},
      sleep: async () => {},
    });

    expect(calls.some((c) => c[0] === 'event' && c[1] === 'escalate')).toBe(false);

    stopped = false;
    const calls2: any[] = [];
    await waitForMerge(21, 'ship-it/21-self-merge', '/repo', 'on-par/software-factory', paths, {
      createOctokit: () => ({}) as any,
      pathExists: () => stopped,
      checkMerged: async () => {
        stopped = true;
        throw Object.assign(new Error('access denied'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        });
      },
      loadConfig: () => fakeFactoryConfig(false),
      land: async () => {
        throw new Error('land should not be called');
      },
      emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
        calls2.push(['event', type, issue, msg]),
      writeLine: () => {},
      sleep: async () => {},
    });

    expect(calls2.some((c) => c[0] === 'event' && c[1] === 'escalate')).toBe(false);
  });

  it('classifies permanent vs transient merged-state check errors', () => {
    expect(isPermanentMergeCheckError(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(isPermanentMergeCheckError(Object.assign(new Error('x'), { status: 403 }))).toBe(true);
    expect(isPermanentMergeCheckError(Object.assign(new Error('API rate limit exceeded'), { status: 403 }))).toBe(
      false,
    );
    expect(
      isPermanentMergeCheckError(
        Object.assign(new Error('x'), { status: 403, response: { headers: { 'x-ratelimit-remaining': '0' } } }),
      ),
    ).toBe(false);
    expect(
      isPermanentMergeCheckError(
        Object.assign(new Error('x'), { status: 403, response: { headers: { 'retry-after': '30' } } }),
      ),
    ).toBe(false);
    expect(isPermanentMergeCheckError(Object.assign(new Error('x'), { status: 500 }))).toBe(false);
    expect(isPermanentMergeCheckError(new Error('network'))).toBe(false);
    expect(isPermanentMergeCheckError(undefined)).toBe(false);
    expect(isPermanentMergeCheckError(null)).toBe(false);
  });

  it('squash-merges a PR and deletes its branch', async () => {
    const calls: any[] = [];
    const octokit: any = {
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
      },
    };

    // cmdLand reuses withGitLock for merge serialization; lock behavior is covered in core.
    await squashMergeAndDelete(octokit, 'on-par', 'software-factory', 'ship-it/19-land', 123);

    expect(calls).toEqual([
      ['merge', { owner: 'on-par', repo: 'software-factory', pull_number: 123, merge_method: 'squash' }],
      ['deleteRef', { owner: 'on-par', repo: 'software-factory', ref: 'heads/ship-it/19-land' }],
    ]);
  });

  it('uses GitHub admin override when admin merge is enabled', async () => {
    const calls: any[] = [];
    const octokit: any = {
      rest: {
        pulls: {
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
      },
    };
    const run = async (command: string) => {
      calls.push(['run', command]);
    };

    await squashMergeAndDelete(octokit, 'on-par', 'software-factory', 'ship-it/19-land', 123, {
      admin: true,
      run,
    });

    expect(calls).toEqual([
      ['run', "gh pr merge 123 --repo 'on-par/software-factory' --admin --squash --delete-branch"],
    ]);
  });

  it('does not throw when deleting the merged branch fails', async () => {
    const octokit: any = {
      rest: {
        pulls: { merge: async () => {} },
        git: {
          deleteRef: async () => {
            throw new Error('not found');
          },
        },
      },
    };

    await expect(
      squashMergeAndDelete(octokit, 'on-par', 'software-factory', 'ship-it/19-land', 123),
    ).resolves.toBeUndefined();
  });

  it('pins both merge paths to the verified head SHA when one is given', async () => {
    const calls: any[] = [];
    const octokit: any = {
      rest: {
        pulls: { merge: async (args: any) => calls.push(['merge', args]) },
        git: { deleteRef: async () => {} },
      },
    };
    const run = async (command: string) => {
      calls.push(['run', command]);
    };

    await squashMergeAndDelete(octokit, 'on-par', 'software-factory', 'ship-it/19-land', 123, { sha: 'abc123' });
    await squashMergeAndDelete(octokit, 'on-par', 'software-factory', 'ship-it/19-land', 123, {
      admin: true,
      run,
      sha: 'abc123',
    });

    expect(calls).toEqual([
      ['merge', { owner: 'on-par', repo: 'software-factory', pull_number: 123, merge_method: 'squash', sha: 'abc123' }],
      [
        'run',
        "gh pr merge 123 --repo 'on-par/software-factory' --admin --squash --delete-branch --match-head-commit 'abc123'",
      ],
    ]);
  });

  it('recognizes a head-moved merge refusal from the REST API and from gh', () => {
    expect(isHeadModifiedMergeError(Object.assign(new Error('Conflict'), { status: 409 }))).toBe(true);
    expect(
      isHeadModifiedMergeError(
        Object.assign(new Error('Command failed: gh pr merge'), {
          stderr: 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)',
        }),
      ),
    ).toBe(true);
    expect(isHeadModifiedMergeError(Object.assign(new Error('Base branch was modified'), { status: 405 }))).toBe(false);
    expect(isHeadModifiedMergeError(new Error('Pull Request is still a draft'))).toBe(false);
  });

  describe('landOpenPullRequest head-SHA pinning', () => {
    const cleanOctokit = (merge: (args: any) => Promise<unknown>, calls: any[]): any => ({
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } } }),
      rest: {
        pulls: {
          get: async (args: any) => {
            calls.push(['get', args.pull_number]);
            return { data: { head: { sha: 'abc123' } } };
          },
          merge,
        },
        git: { deleteRef: async () => {} },
      },
    });
    const baseOpts = {
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-pin',
      worktree: '/repo-factory-20',
      prNumber: 123,
      pathExists: () => true,
      sleep: async () => {
        throw new Error('sleep should not be called');
      },
    };

    it('watches CI on the PR head SHA, not the branch ref, and merges that SHA', async () => {
      const calls: any[] = [];
      const octokit = cleanOctokit(async (args) => calls.push(['merge', args.sha]), calls);

      await landOpenPullRequest({
        ...baseOpts,
        octokit,
        log: () => {},
        watch: async (opts) => {
          calls.push(['watch', opts.ref]);
          return 'success';
        },
      });

      expect(calls).toEqual([
        ['get', 123],
        ['watch', 'abc123'],
        ['merge', 'abc123'],
      ]);
    });

    it('logs ci-rescued and merges when an infra failure reruns green', async () => {
      vi.useFakeTimers();
      try {
        const calls: any[] = [];
        const octokit = cleanOctokit(async (args) => calls.push(['merge', args.sha]), calls);
        octokit.rest.checks = {
          listForRef: async () => ({
            data: { check_runs: [{ id: 9, head_sha: 'abc123', status: 'completed', conclusion: 'failure' }] },
          }),
        };
        octokit.rest.actions = {
          getJobForWorkflowRun: async () => ({
            data: { conclusion: 'failure', runner_id: 42, runner_name: 'r', steps: [], run_id: 7, run_attempt: 1 },
          }),
        };
        const outcomes = ['failure', 'success'] as const;
        let watchCalls = 0;

        const landed = landOpenPullRequest({
          ...baseOpts,
          octokit,
          log: (type, msg) => calls.push(['log', type, msg]),
          watch: async () => outcomes[watchCalls++],
          rerun: async (argv) => {
            calls.push(['rerun', [...argv]]);
            return { ok: true };
          },
        });
        await vi.advanceTimersByTimeAsync(60_000);
        await landed;

        expect(calls.filter((c) => c[0] === 'rerun')).toEqual([
          ['rerun', ['gh', 'run', 'rerun', '7', '--failed', '--repo', 'on-par/software-factory']],
        ]);
        expect(calls.some((c) => c[0] === 'log' && c[1] === 'ci-rescued')).toBe(true);
        expect(calls).toContainEqual(['merge', 'abc123']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('parks as ci-infra and logs ci-rescue-failed when the infra rerun also fails', async () => {
      vi.useFakeTimers();
      try {
        const calls: any[] = [];
        const octokit = cleanOctokit(async (args) => calls.push(['merge', args.sha]), calls);
        // The module-level rerun budget is shared across tests, so this SHA must be unique to this one.
        octokit.rest.checks = {
          listForRef: async () => ({
            data: { check_runs: [{ id: 9, head_sha: 'infra-sha-2366', status: 'completed', conclusion: 'failure' }] },
          }),
        };
        octokit.rest.actions = {
          getJobForWorkflowRun: async () => ({
            data: {
              conclusion: 'failure',
              runner_id: 42,
              runner_name: 'r',
              steps: [],
              run_id: 7,
              run_attempt: 1,
              head_sha: 'infra-sha-2366',
            },
          }),
        };
        const outcomes = ['failure', 'failure'] as const;
        let watchCalls = 0;

        const landed = landOpenPullRequest({
          ...baseOpts,
          octokit,
          log: (type, msg) => calls.push(['log', type, msg]),
          watch: async () => outcomes[watchCalls++],
          rerun: async (argv) => {
            calls.push(['rerun', [...argv]]);
            return { ok: true };
          },
        }).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(60_000);
        const err = await landed;

        expect(err).toBeInstanceOf(CiInfraError);
        expect(err).toBeInstanceOf(CiFailedError);
        expect(parkReasonFor(err)).toBe('ci-infra');
        expect(calls.filter((c) => c[0] === 'rerun')).toHaveLength(1);
        const logTypes = calls.filter((c) => c[0] === 'log').map((c) => c[1]);
        expect(logTypes).toContain('ci-rescue-failed');
        expect(logTypes).toContain('ci-infra');
        expect(logTypes).not.toContain('ci-failed');
        expect(calls.some((c) => c[0] === 'merge')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces a 409 head-moved merge refusal as CI-unverified without retrying', async () => {
      const calls: any[] = [];
      let mergeCalls = 0;
      const octokit = cleanOctokit(async () => {
        mergeCalls++;
        throw Object.assign(new Error('Head branch was modified. Review and try the merge again.'), { status: 409 });
      }, calls);

      const err = await landOpenPullRequest({
        ...baseOpts,
        octokit,
        log: (type, msg) => calls.push(['log', type, msg]),
        watch: async () => 'success',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CiUnverifiedError);
      expect(mergeCalls).toBe(1);
      expect(calls).toContainEqual([
        'log',
        'ci-failed',
        'PR #123 head moved past CI-verified commit abc123 — refusing to merge an unverified head',
      ]);
    });

    it('still runs an unpinned admin merge when the CI watch is skipped', async () => {
      const calls: any[] = [];
      const octokit = cleanOctokit(async () => calls.push(['merge']), calls);

      await landOpenPullRequest({
        ...baseOpts,
        octokit,
        log: () => {},
        run: async (command: string) => calls.push(['run', command]),
        skipCI: true,
        adminMerge: true,
      });

      const runs = calls.filter((c) => c[0] === 'run');
      expect(runs).toHaveLength(1);
      expect(runs[0][1]).toContain('--admin');
      expect(runs[0][1]).not.toContain('--match-head-commit');
    });

    it('still merges unpinned when the CI watch is skipped without admin', async () => {
      const calls: any[] = [];
      const octokit = cleanOctokit(async (args) => calls.push(['merge', args.sha]), calls);

      await landOpenPullRequest({ ...baseOpts, octokit, log: () => {}, skipCI: true });

      expect(calls).toEqual([['merge', undefined]]);
    });
  });

  it('reads the pull request land state fields', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        calls.push({ query, vars });
        return { repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' } } };
      },
    };

    await expect(getPullRequestLandState(octokit, 'on-par', 'software-factory', 123)).resolves.toEqual({
      id: 'PR_1',
      isDraft: false,
      mergeStateStatus: 'DIRTY',
    });
    expect(calls[0].vars).toEqual({ owner: 'on-par', repo: 'software-factory', number: 123 });
    expect(calls[0].query).toContain('isDraft');
    expect(calls[0].query).toContain('mergeStateStatus');
  });

  it('marks a pull request ready for review by node id', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        calls.push({ query, vars });
      },
    };

    await markPullRequestReady(octokit, 'PR_1');

    expect(calls[0].vars).toEqual({ id: 'PR_1' });
    expect(calls[0].query).toContain('markPullRequestReadyForReview');
  });

  it('fails closed when the CI watch throws', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } } }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-ci-down',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => true,
        sleep: async () => {
          throw new Error('sleep should not be called');
        },
        watch: async () => {
          throw new Error('api down');
        },
      }),
    ).rejects.toThrow(CiUnverifiedError);

    const failCall = calls.find((c) => c[0] === 'log' && c[1] === 'ci-failed');
    expect(failCall).toBeDefined();
    expect(failCall[2]).toContain('CI watch');
    expect(failCall[2]).toContain('api down');
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
    expect(calls.some((c) => c[0] === 'deleteRef')).toBe(false);
  });

  it('fails closed on a timeout outcome from the CI watch', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } } }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-ci-timeout',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => true,
        sleep: async () => {
          throw new Error('sleep should not be called');
        },
        watch: async () => 'timeout',
      }),
    ).rejects.toThrow(CiUnverifiedError);

    const failCall = calls.find((c) => c[0] === 'log' && c[1] === 'ci-failed');
    expect(failCall).toBeDefined();
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
  });

  it('fails closed on a timeout outcome even with adminMerge (FACTORY_MERGE_ADMIN=1) set', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } } }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-ci-timeout-admin',
        worktree: '/repo-factory-20',
        prNumber: 707,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => true,
        adminMerge: true,
        sleep: async () => {
          throw new Error('sleep should not be called');
        },
        watch: async () => 'timeout',
      }),
    ).rejects.toThrow(CiUnverifiedError);

    expect(calls.some((c) => c[0] === 'run' && typeof c[1] === 'string' && c[1].includes('--admin'))).toBe(false);
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
  });

  it('refuses to merge and throws CiFailedError when CI ends in failure (regression: owner/example-app#707 merged with a failing e2e check)', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } } }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'failure' }] } }),
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-ci-failed',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => true,
        sleep: async () => {
          throw new Error('sleep should not be called');
        },
      }),
    ).rejects.toThrow(CiFailedError);

    const failCall = calls.find((c) => c[0] === 'log' && c[1] === 'ci-failed');
    expect(failCall).toBeDefined();
    expect(failCall[2]).toContain('refusing to merge');
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
  });

  it('refuses to merge on a confirmed CI failure even with adminMerge (FACTORY_MERGE_ADMIN=1) set — the exact owner/example-app#707 scenario', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } } }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: {
          deleteRef: async (args: any) => {
            calls.push(['deleteRef', args]);
          },
        },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'failure' }] } }),
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-ci-failed-admin',
        worktree: '/repo-factory-20',
        prNumber: 707,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => true,
        adminMerge: true,
        sleep: async () => {
          throw new Error('sleep should not be called');
        },
      }),
    ).rejects.toThrow(CiFailedError);

    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
  });

  it('logs a warn when the ready-for-review flip fails but still merges', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async (query: string) => {
        if (query.trimStart().startsWith('query')) {
          return { repository: { pullRequest: { id: 'PR_1', isDraft: true, mergeStateStatus: 'BLOCKED' } } };
        }
        if (query.includes('markPullRequestReadyForReview')) {
          throw new Error('flip failed');
        }
        throw new Error('unexpected graphql');
      },
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async (args: any) => calls.push(['deleteRef', args]) },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-flip-fails',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: (type, msg) => calls.push(['log', type, msg]),
      run: async () => {},
      pathExists: () => true,
      sleep: async () => {
        throw new Error('sleep should not be called');
      },
      watch: async () => 'success' as const,
    });

    const warnCall = calls.find((c) => c[0] === 'log' && c[1] === 'warn');
    expect(warnCall).toBeDefined();
    expect(warnCall[2]).toContain('ready-for-review flip failed');
    expect(calls).toContainEqual([
      'merge',
      { owner: 'on-par', repo: 'software-factory', pull_number: 123, merge_method: 'squash', sha: 'abc123' },
    ]);
  });

  it('aborts a merge conflict, logs the paths, and skips merge when sync fails', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
      if (command === 'git status --porcelain -z') return { stdout: '' };
      if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/operation' };
      if (command.startsWith('test -e')) return { stdout: 'no' };
      if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
        return { stdout: 'a'.repeat(40) };
      if (command.startsWith('git diff --diff-filter=A')) return { stdout: '' };
      if (command === 'git merge --no-edit origin/main') throw new Error('conflict');
      if (command === 'git diff --name-only --diff-filter=U -z') return { stdout: 'source.ts\0' };
      if (command === 'git merge --abort') return { stdout: '' };
      return { stdout: '' };
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-dirty',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => true,
        sleep: async () => {
          throw new Error('sleep should not be called');
        },
        watch: async () => 'success' as const,
      }),
    ).rejects.toBeInstanceOf(LandConflictError);

    expect(calls.some((call) => call[1] === 'git merge --abort')).toBe(true);
    expect(calls.some((call) => call[1] === "git push origin 'ship-it/20-dirty'")).toBe(false);
    expect(calls.at(-1)?.[1]).toBe('conflict');
    expect(calls.at(-1)?.[2]).toContain('source.ts');
  });

  it('logs conflict and skips merge when a DIRTY PR worktree is gone', async () => {
    const calls: any[] = [];
    const octokit: any = {
      graphql: async () => ({ repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' } } }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };
    const run = async (command: string, options: any) => {
      calls.push(['run', command, options]);
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-dirty',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: (type, msg) => calls.push(['log', type, msg]),
        run,
        pathExists: () => false,
        sleep: async () => {
          throw new Error('sleep should not be called');
        },
        watch: async () => 'success' as const,
      }),
    ).rejects.toBeInstanceOf(LandConflictError);

    expect(calls).toEqual([['log', 'conflict', 'PR #123 DIRTY on ship-it/20-dirty and worktree gone']]);
  });

  it('re-issues the ready flip when the PR is still a draft, then merges', async () => {
    const calls: any[] = [];
    const sleeps: number[] = [];
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        if (query.trimStart().startsWith('query')) {
          calls.push(['query', vars]);
          return { repository: { pullRequest: { id: 'PR_1', isDraft: true, mergeStateStatus: 'BLOCKED' } } };
        }
        if (query.includes('markPullRequestReadyForReview')) {
          calls.push(['mutation', vars]);
          return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
        }
        throw new Error('unexpected graphql');
      },
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async (args: any) => {
            calls.push(['merge', args]);
          },
        },
        git: { deleteRef: async (args: any) => calls.push(['deleteRef', args]) },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-draft',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: (type, msg) => calls.push(['log', type, msg]),
      run: async () => {},
      pathExists: () => true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      watch: async () => 'success' as const,
    });

    expect(calls.findIndex((c) => c[0] === 'mutation')).toBeLessThan(calls.findIndex((c) => c[0] === 'merge'));
    expect(calls).toContainEqual(['mutation', { id: 'PR_1' }]);
    expect(sleeps).toEqual([]);
  });

  it('retries the merge with backoff while the PR is still a draft', async () => {
    const sleeps: number[] = [];
    const states = [
      { id: 'PR_1', isDraft: true, mergeStateStatus: 'BLOCKED' },
      { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' },
    ];
    let mergeCalls = 0;
    const octokit: any = {
      graphql: async (query: string, vars: any) => {
        if (query.trimStart().startsWith('query')) {
          return { repository: { pullRequest: states.shift() } };
        }
        expect(query).toContain('markPullRequestReadyForReview');
        expect(vars).toEqual({ id: 'PR_1' });
        return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
      },
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async () => {
            mergeCalls++;
            if (mergeCalls === 1) throw new Error('Pull Request is still a draft');
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-draft',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: () => {},
      run: async () => {},
      pathExists: () => true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      watch: async () => 'success' as const,
    });

    expect(mergeCalls).toBe(2);
    expect(sleeps).toEqual([5000]);
  });

  it('retries while mergeStateStatus is UNKNOWN', async () => {
    const sleeps: number[] = [];
    let mergeCalls = 0;
    let mutationCalls = 0;
    const octokit: any = {
      graphql: async (query: string) => {
        if (query.trimStart().startsWith('query')) {
          return { repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'UNKNOWN' } } };
        }
        mutationCalls++;
        return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
      },
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async () => {
            mergeCalls++;
            if (mergeCalls < 3) throw new Error('Pull Request is not mergeable');
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-unknown',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: () => {},
      run: async () => {},
      pathExists: () => true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      watch: async () => 'success' as const,
    });

    expect(mergeCalls).toBe(3);
    expect(sleeps).toEqual([5000, 10000]);
    expect(mutationCalls).toBe(0);
  });

  it('parks only after retries are exhausted', async () => {
    const sleeps: number[] = [];
    const mergeError = new Error('Pull Request is still a draft');
    let mergeCalls = 0;
    const octokit: any = {
      graphql: async () => ({
        repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'UNKNOWN' } },
      }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async () => {
            mergeCalls++;
            throw mergeError;
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    await expect(
      landOpenPullRequest({
        octokit,
        owner: 'on-par',
        repoName: 'software-factory',
        ghRepo: 'on-par/software-factory',
        repoRoot: '/repo',
        issue: 20,
        branch: 'ship-it/20-retry',
        worktree: '/repo-factory-20',
        prNumber: 123,
        log: () => {},
        run: async () => {},
        pathExists: () => true,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        watch: async () => 'success' as const,
      }),
    ).rejects.toBe(mergeError);

    expect(mergeCalls).toBe(5);
    expect(sleeps).toEqual([5000, 10000, 20000, 40000]);
  });

  it('classifies a review-blocked merge as awaiting-review without retrying', async () => {
    const sleeps: number[] = [];
    const logs: Array<[string, string]> = [];
    let mergeCalls = 0;
    const octokit: any = {
      graphql: async () => ({
        repository: {
          pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' },
        },
      }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async () => {
            mergeCalls++;
            throw new Error('At least 1 approving review is required by reviewers with write access.');
          },
        },
        git: { deleteRef: async () => {} },
        checks: {
          listForRef: async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }),
        },
      },
    };

    const err = await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-review',
      worktree: '/repo-factory-20',
      prNumber: 555,
      log: (type, msg) => logs.push([type, msg]),
      run: async () => {},
      pathExists: () => true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      watch: async () => 'success' as const,
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(err).toBeInstanceOf(AwaitingReviewError);
    expect((err as AwaitingReviewError).prNumber).toBe(555);
    expect(mergeCalls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(logs.some(([type, msg]) => type === 'awaiting-review' && msg.includes('555'))).toBe(true);
  });

  it('releases the lock for the CI watch on the CLEAN path', async () => {
    const trace: string[] = [];
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      trace.push('lock:acquire');
      try {
        return await fn();
      } finally {
        trace.push('lock:release');
      }
    };
    const watch = async () => {
      trace.push('watch');
      return 'success' as const;
    };
    const octokit: any = {
      graphql: async () => ({
        repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } },
      }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async () => {
            trace.push('merge');
          },
        },
        git: { deleteRef: async () => {} },
      },
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-clean',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: () => {},
      run: async () => {},
      pathExists: () => true,
      sleep: async () => {
        throw new Error('sleep should not be called');
      },
      watch,
      withLock,
    });

    expect(trace).toEqual(['watch', 'lock:acquire', 'merge', 'lock:release']);
  });

  it('fetches and syncs main under lock before the first watch, then watches outside the lock', async () => {
    const trace: string[] = [];
    let pushed = false;
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      trace.push('lock:acquire');
      try {
        return await fn();
      } finally {
        trace.push('lock:release');
      }
    };
    const watch = async () => {
      trace.push('watch');
      return 'success' as const;
    };
    const octokit: any = {
      graphql: async () => ({
        repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: pushed ? 'CLEAN' : 'DIRTY' } },
      }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async () => {
            trace.push('merge');
          },
        },
        git: { deleteRef: async () => {} },
      },
    };
    const run = async (command: string) => {
      if (command === 'git status --porcelain -z') return { stdout: '' };
      if (command.startsWith('git rev-parse --git-path')) return { stdout: '.git/operation' };
      if (command.startsWith('test -e')) return { stdout: 'no' };
      if (command === 'git rev-parse --verify HEAD' || command.startsWith('git merge-base'))
        return { stdout: 'a'.repeat(40) };
      if (command.startsWith('git diff --diff-filter=A')) return { stdout: '' };
      if (command === 'git fetch origin') trace.push('fetch');
      else if (command === 'git merge --no-edit origin/main') trace.push('merge-main');
      else if (command.startsWith('git push')) {
        pushed = true;
        trace.push('push');
      }
      return { stdout: '' };
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-dirty-lock',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: () => {},
      run,
      pathExists: () => true,
      sleep: async () => {
        throw new Error('sleep should not be called');
      },
      watch,
      withLock,
    });

    expect(trace).toEqual([
      'lock:acquire',
      'fetch',
      'merge-main',
      'push',
      'lock:release',
      'watch',
      'lock:acquire',
      'merge',
      'lock:release',
    ]);
  });

  it('does not sync when the DIRTY verdict resolves before the lock is acquired', async () => {
    const trace: string[] = [];
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => fn();
    let watchCalls = 0;
    const watch = async () => {
      watchCalls++;
      return 'success' as const;
    };
    let queryCalls = 0;
    const octokit: any = {
      graphql: async () => {
        queryCalls++;
        return {
          repository: {
            pullRequest:
              queryCalls === 1
                ? { id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' }
                : { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' },
          },
        };
      },
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async () => {
            trace.push('merge');
          },
        },
        git: { deleteRef: async () => {} },
      },
    };
    const run = async () => {
      throw new Error('run should not be called');
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-resolved',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: () => {},
      run,
      pathExists: () => true,
      sleep: async () => {
        throw new Error('sleep should not be called');
      },
      watch,
      withLock,
    });

    expect(trace).toEqual(['merge']);
    expect(watchCalls).toBe(1);
  });

  it('sleeps outside the lock between merge retry attempts', async () => {
    const trace: string[] = [];
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      trace.push('lock:acquire');
      try {
        return await fn();
      } finally {
        trace.push('lock:release');
      }
    };
    let mergeCalls = 0;
    const octokit: any = {
      graphql: async () => ({
        repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'CLEAN' } },
      }),
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: 'abc123' } } }),
          merge: async () => {
            mergeCalls++;
            trace.push('merge');
            if (mergeCalls === 1) throw new Error('Pull Request is not mergeable');
          },
        },
        git: { deleteRef: async () => {} },
      },
    };

    await landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 20,
      branch: 'ship-it/20-backoff',
      worktree: '/repo-factory-20',
      prNumber: 123,
      log: () => {},
      run: async () => {},
      pathExists: () => true,
      sleep: async () => {
        trace.push('sleep');
      },
      watch: async () => 'success' as const,
      withLock,
    });

    expect(trace).toEqual(['lock:acquire', 'merge', 'lock:release', 'sleep', 'lock:acquire', 'merge', 'lock:release']);
  });

  describe('isReviewRequiredMergeError', () => {
    it('matches the GitHub REST 405 approving-review message regardless of state', () => {
      expect(
        isReviewRequiredMergeError(
          new Error('At least 1 approving review is required by reviewers with write access.'),
          {},
        ),
      ).toBe(true);
    });

    it('matches a generic not-mergeable error when state is BLOCKED with REVIEW_REQUIRED', () => {
      expect(
        isReviewRequiredMergeError(new Error('Pull Request is not mergeable'), {
          mergeStateStatus: 'BLOCKED',
          reviewDecision: 'REVIEW_REQUIRED',
        }),
      ).toBe(true);
    });

    it('does not match the same message when BLOCKED is caused by something other than review (e.g. red CI)', () => {
      expect(
        isReviewRequiredMergeError(new Error('Pull Request is not mergeable'), {
          mergeStateStatus: 'BLOCKED',
          reviewDecision: 'APPROVED',
        }),
      ).toBe(false);
    });

    it('does not match unrelated merge failures', () => {
      expect(isReviewRequiredMergeError(new Error('merge conflict'), { mergeStateStatus: 'DIRTY' })).toBe(false);
    });
  });

  describe('parkReasonFor', () => {
    it('maps a LaneParkError to its own reason', () => {
      expect(parkReasonFor(new LaneParkError('x', 'escalate'))).toBe('escalate');
      expect(parkReasonFor(new LaneParkError('x', 'fail'))).toBe('fail');
    });

    it('carries the failure signature and failing checks on LaneParkError when given', () => {
      const err = new LaneParkError('x', 'fail', { failureSignature: 's', failingChecks: ['lint'] });
      expect(err.failureSignature).toBe('s');
      expect(err.failingChecks).toEqual(['lint']);
      expect(err.outcome).toEqual({ state: 'parked', reason: 'fail', failureSignature: 's', failingChecks: ['lint'] });
      const bare = new LaneParkError('x', 'fail');
      expect(bare.failureSignature).toBeUndefined();
      expect(bare.failingChecks).toBeUndefined();
      expect(bare.outcome).toEqual({ state: 'parked', reason: 'fail' });
    });

    it('maps a LandConflictError to conflict', () => {
      expect(parkReasonFor(new LandConflictError('x'))).toBe('conflict');
    });

    it('maps a CiFailedError to ci-failed', () => {
      expect(parkReasonFor(new CiFailedError('x', 707))).toBe('ci-failed');
    });

    it('maps a CiUnverifiedError to ci-failed', () => {
      expect(parkReasonFor(new CiUnverifiedError('x', 707))).toBe('ci-failed');
    });

    it('maps an error carrying reason: timeout to timeout', () => {
      expect(parkReasonFor(Object.assign(new Error('x'), { reason: 'timeout' }))).toBe('timeout');
    });

    it('defaults a plain Error or LandFailureError to fail', () => {
      expect(parkReasonFor(new Error('x'))).toBe('fail');
      expect(parkReasonFor(new LandFailureError('x', 5))).toBe('fail');
    });
  });

  describe('parkEvents', () => {
    it('emits a stuck event alongside the timeout event when a run times out', () => {
      const err = Object.assign(new Error('build timed out after 3600s'), { reason: 'timeout' });
      const events = parkEvents(err);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'timeout', msg: 'build timed out after 3600s' });
      expect(events[1].type).toBe('stuck');
      expect(events[1].msg).toContain('phase timeout');
      expect(events[1].msg).toContain('build timed out after 3600s');
    });

    it('emits only the terminal event for non-timeout park reasons', () => {
      expect(parkEvents(new LaneParkError('x', 'escalate'))).toEqual([{ type: 'escalate', msg: 'x' }]);
      expect(parkEvents(new Error('boom'))).toEqual([{ type: 'fail', msg: 'boom' }]);
      expect(parkEvents(new LandConflictError('sync conflict'))).toEqual([{ type: 'conflict', msg: 'sync conflict' }]);
    });

    it('stringifies a non-Error input', () => {
      expect(parkEvents('oops')).toEqual([{ type: 'fail', msg: 'oops' }]);
    });
  });

  describe('claim-time declared prerequisites (#3267)', () => {
    const preflightDeps = {
      expectedHeadRepoFullName: 'on-par/software-factory',
      getMergedClosingPr: async () => undefined,
      findOpenPR: async () => undefined,
      getLandState: async () => ({ isDraft: false, mergeStateStatus: 'CLEAN' }),
      watch: async () => 'success' as const,
      findSlicePlan: async () => ({ status: 'not-found' as const }),
      getPullState: async () => 'open' as const,
      saveSlicePlan: async () => {},
      autoMergeStack: false,
      stackMode: false,
      getPullReviews: async (): Promise<never> => {
        throw new Error('unexpected review lookup');
      },
      getPullRefs: async () => ({ headRef: 'branch', baseRef: 'main', headSha: 'head' }),
      branchContains: async () => false,
    };

    it('preflight defers a queued issue whose Prerequisite is still open (#3258 on 10/19)', async () => {
      const touched = vi.fn();
      const events = vi.fn();
      await expect(
        preflightQueuedIssue(
          { number: 3258, labels: [] },
          {
            ...preflightDeps,
            readIssueBody: async () => 'Prerequisite: #3256',
            getPrerequisiteState: async () => ({ state: 'open' as const, mergedClosingPr: false }),
            findSlicePlan: touched,
            findOpenPR: touched,
            watch: touched,
            onDeferred: events,
          },
        ),
      ).resolves.toEqual({ kind: 'defer' });
      expect(events).toHaveBeenCalledWith(3258, 'waiting for prerequisites: #3256');
      expect(touched).not.toHaveBeenCalled();
    });

    it('claims through preflight after a prerequisite closes with a merged PR', async () => {
      const make = (state: 'open' | 'closed', mergedClosingPr: boolean) =>
        preflightQueuedIssue(
          { number: 3258, labels: [] },
          {
            ...preflightDeps,
            readIssueBody: async () => 'Prerequisite: #3256',
            getPrerequisiteState: async () => ({ state, mergedClosingPr }),
          },
        );
      await expect(make('open', false)).resolves.toEqual({ kind: 'defer' });
      await expect(make('closed', true)).resolves.toEqual({ kind: 'build' });
    });

    it('parks a closed unmerged prerequisite with its exact reason', async () => {
      const result = await preflightQueuedIssue(
        { number: 3258, labels: [] },
        {
          ...preflightDeps,
          readIssueBody: async () => 'Prerequisite: #3256',
          getPrerequisiteState: async () => ({ state: 'closed' as const, mergedClosingPr: false }),
        },
      );
      expect(result).toEqual({ kind: 'park', reason: 'prerequisite #3256 closed unmerged' });
    });

    it('defers prerequisite lookup failures without claiming or parking', async () => {
      const onDeferred = vi.fn();
      const result = await preflightQueuedIssue(
        { number: 3258, labels: [] },
        {
          ...preflightDeps,
          readIssueBody: async () => 'Prerequisite: #3256',
          getPrerequisiteState: async () => {
            throw new Error('rate limited');
          },
          onDeferred,
        },
      );
      expect(result).toEqual({ kind: 'defer' });
      expect(onDeferred).toHaveBeenCalledWith(3258, expect.stringContaining('rate limited'));
    });
  });

  describe('sweepBetweenLaneIssues (#1757)', () => {
    let tmp: string;
    let lanePaths: any;
    const idleReport = {
      removed: [],
      kept: 3,
      dryRun: false,
      issueNotFound: [],
      issueUnverifiable: [],
      noActiveClaim: [],
      held: [],
    };
    const cfg = (autoGcOnRun: boolean): any => ({ worktree: { autoGcOnRun, gcTtlDays: 7 } });

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'sweep-between-'));
      lanePaths = {
        events: join(tmp, 'events.ndjson'),
        config: join(tmp, 'config.yaml'),
        mergeLock: join(tmp, 'merge.lock'),
        gitLock: join(tmp, 'git.lock'),
      };
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('does nothing when worktree.autoGcOnRun is false', async () => {
      const sweep = vi.fn();
      const emitEvent = vi.fn();
      const result = await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
        loadConfig: () => cfg(false),
        sweep: sweep as any,
        emitEvent: emitEvent as any,
        octokit: () => undefined as any,
      });

      expect(result).toBe('disabled');
      expect(sweep).not.toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it('skips without stealing when another lane holds the land lock', async () => {
      await mkdir(lanePaths.mergeLock, { recursive: true });
      await writeFile(join(lanePaths.mergeLock, 'pid'), String(process.pid));
      const sweep = vi.fn();
      const emitEvent = vi.fn();
      const result = await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
        loadConfig: () => cfg(true),
        sweep: sweep as any,
        emitEvent: emitEvent as any,
        octokit: () => undefined as any,
      });

      expect(result).toBe('land-in-progress');
      expect(sweep).not.toHaveBeenCalled();
      expect(emitEvent.mock.calls.filter((c) => c[1] === 'worktree-gc')).toHaveLength(0);
      expect(existsSync(lanePaths.mergeLock)).toBe(true);
    });

    it('stays quiet when nothing was removed and releases both locks', async () => {
      const emitEvent = vi.fn();
      const result = await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
        loadConfig: () => cfg(true),
        sweep: (async () => idleReport) as any,
        emitEvent: emitEvent as any,
        octokit: () => undefined as any,
      });

      expect(result).toBe('swept');
      expect(emitEvent.mock.calls.filter((c) => c[1] === 'worktree-gc')).toHaveLength(0);
      expect(existsSync(lanePaths.mergeLock)).toBe(false);
      expect(existsSync(lanePaths.gitLock)).toBe(false);
    });

    it('logs one worktree-gc event when it removed something', async () => {
      const emitEvent = vi.fn();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
          loadConfig: () => cfg(true),
          sweep: (async () => ({
            ...idleReport,
            removed: [
              {
                path: '/wt/1',
                branch: 'ship-it/1-x',
                ageDays: 9,
                reason: 'issue-closed',
                scrubbedFiles: [],
                branchDeleted: true,
              },
            ],
          })) as any,
          emitEvent: emitEvent as any,
          octokit: () => undefined as any,
        });

        expect(result).toBe('swept');
        const gc = emitEvent.mock.calls.filter((c) => c[1] === 'worktree-gc');
        expect(gc).toHaveLength(1);
        expect(gc[0][2]).toBe(7);
        expect(gc[0][3]).toMatch(/removed 1 stale worktree\(s\), kept/);
        expect(gc[0][4]).toEqual({ lane: 'app' });
      } finally {
        log.mockRestore();
      }
    });

    it('never throws: a failing sweep becomes a warn event', async () => {
      const emitEvent = vi.fn();
      const result = await sweepBetweenLaneIssues(7, 'app', tmp, 'o/r', lanePaths, {
        loadConfig: () => cfg(true),
        sweep: (async () => {
          throw new Error('boom');
        }) as any,
        emitEvent: emitEvent as any,
        octokit: () => undefined as any,
      });

      expect(result).toBe('failed');
      const warns = emitEvent.mock.calls.filter((c) => c[1] === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0][3]).toContain('mid-run worktree gc failed: boom');
    });
  });

  describe('tuiQueueReader (#1362)', () => {
    const base = { queueFile: '/nowhere/queue', queueProposedFile: '/nowhere/queue.proposed', repo: 'o/r' };
    const listForRepo = vi.fn(async () => ({
      data: [{ number: 5, title: 'Five', labels: ['factory:queued', 'factory:lane:ops', 'factory:order:1'] }],
    }));
    const fakeOctokit = { rest: { issues: { listForRepo } } } as any;

    it('--local-queue reads the file and never resolves a token or builds octokit', async () => {
      const token = vi.fn(() => 'ghp_x');
      const octokit = vi.fn(() => fakeOctokit);
      const reader = tuiQueueReader({ ...base, localQueue: true, token, octokit });
      expect(reader.source).toBe('local file');
      expect(await reader.read()).toEqual({ entries: [] });
      expect(token).not.toHaveBeenCalled();
      expect(octokit).not.toHaveBeenCalled();
    });

    it('GitHub path resolves the token up front and builds octokit exactly once across reads', async () => {
      const token = vi.fn(() => 'ghp_x');
      const octokit = vi.fn(() => fakeOctokit);
      const reader = tuiQueueReader({ ...base, localQueue: false, token, octokit });
      expect(token).toHaveBeenCalledTimes(1);
      expect(octokit).toHaveBeenCalledWith('ghp_x');
      const first = await reader.read();
      await reader.read();
      expect(first.entries).toEqual([{ lane: 'ops', issue: 5, title: 'Five', status: 'queued' }]);
      expect(octokit).toHaveBeenCalledTimes(1);
      expect(token).toHaveBeenCalledTimes(1);
    });

    it('with no token at startup, reports it per read and recovers once a token appears', async () => {
      let current: string | undefined = undefined;
      const token = vi.fn(() => current);
      const octokit = vi.fn(() => fakeOctokit);
      const reader = tuiQueueReader({ ...base, localQueue: false, token, octokit });
      expect(reader.pollMs).toBe(30_000);
      expect(await reader.read()).toEqual({ entries: [], error: 'no GitHub token — run `gh auth login`' });
      expect(octokit).not.toHaveBeenCalled();

      current = 'ghp_late';
      expect((await reader.read()).entries).toHaveLength(1);
      expect(octokit).toHaveBeenCalledTimes(1);
      expect(octokit).toHaveBeenCalledWith('ghp_late');
      await reader.read();
      expect(octokit).toHaveBeenCalledTimes(1);
    });

    it('with no detected repo, never touches the token and reports why', async () => {
      const token = vi.fn(() => 'ghp_x');
      const reader = tuiQueueReader({ ...base, repo: undefined, localQueue: false, token });
      expect(reader.pollMs).toBe(30_000);
      expect(await reader.read()).toEqual({
        entries: [],
        error: 'repo detection failed — run inside a GitHub-backed checkout',
      });
      expect(token).not.toHaveBeenCalled();
    });
  });

  describe('planRunLanes', () => {
    it('local mode groups queue file entries by lane without invoking the GitHub queue factory', async () => {
      const result = await planRunLanes({
        localQueue: true,
        readLocalQueue: () => 'app 5\napp 6\ninfra 7\n',
        queue: () => {
          throw new Error('queue() should not be called in local mode');
        },
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.lanes).toEqual([
        { lane: 'app', issues: [5, 6], deps: {} },
        { lane: 'infra', issues: [7], deps: {} },
      ]);
    });

    it('local mode throws CliExitError(2) when the queue file does not exist', async () => {
      await expect(
        planRunLanes({
          localQueue: true,
          readLocalQueue: () => null,
          queue: () => {
            throw new Error('should not be called');
          },
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('queue empty'), code: 2 });
    });

    it('local mode returns diagnostics for malformed lines while keeping the good entries', async () => {
      const result = await planRunLanes({
        localQueue: true,
        readLocalQueue: () => 'app 5\nnot-a-valid-line\n',
        queue: () => {
          throw new Error('should not be called');
        },
      });

      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.lanes).toEqual([{ lane: 'app', issues: [5], deps: {} }]);
    });

    it('GitHub mode builds one planned lane per discovered lane, wired to that lane via the queue', async () => {
      const calls: any[] = [];
      const fakeQueue: GithubQueue = {
        claimSettleMs: 0,
        settle: async () => {},
        claimNext: async (lane) => {
          calls.push(['claimNext', lane]);
          return { issue: 42, decision: { kind: 'build' } };
        },
        release: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
        heartbeat: async () => true,
        list: async () => [],
        lanes: async () => ['app', 'infra'],
        migrateLocalQueue: async () => {},
        enqueue: async () => [],
        previewClear: async () => ({ entries: [], wouldClear: 0, wouldSkip: 0 }),
        clear: async () => ({ entries: [], cleared: 0, skipped: 0, failed: 0 }),
      };

      const result = await planRunLanes({
        localQueue: false,
        readLocalQueue: () => {
          throw new Error('should not be called');
        },
        queue: () => fakeQueue,
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.lanes.map((l) => ({ lane: l.lane, issues: l.issues }))).toEqual([
        { lane: 'app', issues: [] },
        { lane: 'infra', issues: [] },
      ]);

      await result.lanes[0].deps.claimNext!();
      expect(calls).toEqual([['claimNext', 'app']]);

      await result.lanes[0].deps.releaseIssue!(9, 'parked');
      expect(calls).toEqual([
        ['claimNext', 'app'],
        ['release', 9, 'parked'],
      ]);
    });

    it('GitHub mode returns no lanes when nothing is queued', async () => {
      const fakeQueue: GithubQueue = {
        claimSettleMs: 0,
        settle: async () => {},
        claimNext: async () => null,
        release: async () => {},
        heartbeat: async () => true,
        list: async () => [],
        lanes: async () => [],
        migrateLocalQueue: async () => {},
        enqueue: async () => [],
        previewClear: async () => ({ entries: [], wouldClear: 0, wouldSkip: 0 }),
        clear: async () => ({ entries: [], cleared: 0, skipped: 0, failed: 0 }),
      };

      const result = await planRunLanes({
        localQueue: false,
        readLocalQueue: () => {
          throw new Error('should not be called');
        },
        queue: () => fakeQueue,
      });

      expect(result).toEqual({ lanes: [], diagnostics: [] });
    });
  });

  describe('laneQueueDeps', () => {
    it('binds claimNext, releaseIssue, heartbeat, and countRemaining to the given lane through the queue', async () => {
      const calls: any[] = [];
      const fakeQueue: GithubQueue = {
        claimSettleMs: 0,
        settle: async () => {},
        claimNext: async (lane) => {
          calls.push(['claimNext', lane]);
          return { issue: 3, decision: { kind: 'build' } };
        },
        release: async (issue, outcome) => {
          calls.push(['release', issue, outcome]);
        },
        heartbeat: async (issue) => {
          calls.push(['heartbeat', issue]);
          return true;
        },
        list: async (lane) => {
          calls.push(['list', lane]);
          return [4, 5];
        },
        lanes: async () => [],
        migrateLocalQueue: async () => {},
        enqueue: async () => [],
        previewClear: async () => ({ entries: [], wouldClear: 0, wouldSkip: 0 }),
        clear: async () => ({ entries: [], cleared: 0, skipped: 0, failed: 0 }),
      };

      const deps = laneQueueDeps(fakeQueue, 'app');
      expect(await deps.claimNext!()).toEqual({ issue: 3, decision: { kind: 'build' } });
      await deps.releaseIssue!(3, 'done');
      expect(await deps.heartbeat!(3)).toBe(true);
      expect(await deps.countRemaining!()).toBe(2);

      expect(calls).toEqual([
        ['claimNext', 'app'],
        ['release', 3, 'done'],
        ['heartbeat', 3],
        ['list', 'app'],
      ]);
    });
  });

  describe('formatDoctorReport', () => {
    const diagnoses: ModelDiagnosis[] = [
      {
        model: 'claude-opus-4-8',
        provider: 'anthropic',
        tiers: ['boss'],
        reachable: true,
        experimental: false,
        reason: 'ok (claude CLI)',
      },
      {
        model: 'gpt-5.1-codex',
        provider: 'openai',
        tiers: ['worker'],
        reachable: false,
        experimental: false,
        reason: 'codex CLI not found on PATH',
      },
    ];

    it('renders one line per diagnosis with model, provider, tiers, and reason', () => {
      const report = formatDoctorReport(diagnoses);
      expect(report).toContain('== Model Doctor ==');
      expect(report).toContain('claude-opus-4-8');
      expect(report).toContain('provider=anthropic');
      expect(report).toContain('tier=boss');
      expect(report).toContain('ok (claude CLI)');
      expect(report).toContain('gpt-5.1-codex');
      expect(report).toContain('provider=openai');
      expect(report).toContain('tier=worker');
      expect(report).toContain('codex CLI not found on PATH');
    });

    it('marks reachable models with a check and unreachable models with an x', () => {
      const report = formatDoctorReport(diagnoses);
      const lines = report.split('\n');
      expect(lines.find((l) => l.includes('claude-opus-4-8'))).toContain('✅');
      expect(lines.find((l) => l.includes('gpt-5.1-codex'))).toContain('❌');
    });
  });

  describe('formatDoctorReport repo-defined marker', () => {
    const diagnoses: ModelDiagnosis[] = [
      {
        model: 'claude-opus-4-8',
        provider: 'anthropic',
        tiers: ['boss'],
        reachable: true,
        experimental: false,
        reason: 'ok',
      },
      {
        model: 'gpt-5.1-codex',
        provider: 'openai',
        tiers: ['worker'],
        reachable: false,
        experimental: false,
        reason: 'no',
      },
    ];

    it('appends [repo-defined] only to rows whose model is in the repo-defined set', () => {
      const lines = formatDoctorReport(diagnoses, new Set(['gpt-5.1-codex'])).split('\n');
      expect(lines.find((l) => l.includes('gpt-5.1-codex'))).toContain('[repo-defined]');
      expect(lines.find((l) => l.includes('claude-opus-4-8'))).not.toContain('[repo-defined]');
    });

    it('renders no repo-defined marker when no set is passed', () => {
      expect(formatDoctorReport(diagnoses)).not.toContain('repo-defined');
    });
  });

  describe('repoDefinedTag', () => {
    it('returns the marker only for ids in the set', () => {
      expect(repoDefinedTag('a', new Set(['b']))).toBe('');
      expect(repoDefinedTag('a', new Set(['a']))).toContain('[repo-defined]');
    });
  });

  describe('modelStatusIcon', () => {
    const base = { model: 'm', provider: 'ollama', tiers: ['worker'], experimental: false, reason: 'r' };

    it('maps reachable to ✅, unverified to ⚠️, and anything else to ❌', () => {
      expect(modelStatusIcon({ ...base, reachable: true })).toContain('✅');
      expect(modelStatusIcon({ ...base, reachable: false, unverified: true })).toContain('⚠️');
      expect(modelStatusIcon({ ...base, reachable: false })).toContain('❌');
    });
  });

  describe('formatDoctorReport unverified rows', () => {
    const rows: ModelDiagnosis[] = [
      { model: 'ok-m', provider: 'ollama', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      {
        model: 'unv-m',
        provider: 'anthropic',
        tiers: ['boss'],
        reachable: false,
        unverified: true,
        experimental: false,
        reason: 'unverified — no auth evidence: x',
      },
      { model: 'bad-m', provider: 'openai', tiers: ['worker'], reachable: false, experimental: false, reason: 'gone' },
    ];

    it('marks unverified rows with a warning and ends with the count line', () => {
      const report = formatDoctorReport(rows);
      const lines = report.split('\n');
      const line = lines.find((l) => l.includes('unv-m'))!;
      expect(line).toContain('⚠️');
      expect(line).not.toContain('❌');
      expect(lines.at(-1)).toContain('1/3 models reachable, 1 unverified (no auth evidence)');
    });
  });

  describe('hasReachableWorker', () => {
    it('is false when every model is unreachable', () => {
      const diagnoses: ModelDiagnosis[] = [
        {
          model: 'gpt-5.1-codex',
          provider: 'openai',
          tiers: ['worker'],
          reachable: false,
          experimental: false,
          reason: 'codex CLI not found on PATH',
        },
      ];
      expect(hasReachableWorker(diagnoses)).toBe(false);
    });

    it('is false when the only reachable model is boss-tier', () => {
      const diagnoses: ModelDiagnosis[] = [
        {
          model: 'claude-opus-4-8',
          provider: 'anthropic',
          tiers: ['boss'],
          reachable: true,
          experimental: false,
          reason: 'ok (claude CLI)',
        },
      ];
      expect(hasReachableWorker(diagnoses)).toBe(false);
    });

    it('is true when a worker-tier model is reachable', () => {
      const diagnoses: ModelDiagnosis[] = [
        {
          model: 'gpt-5.1-codex',
          provider: 'openai',
          tiers: ['worker'],
          reachable: true,
          experimental: false,
          reason: 'ok (codex CLI)',
        },
      ];
      expect(hasReachableWorker(diagnoses)).toBe(true);
    });

    it('is true when a worker_fallback-tier model is reachable', () => {
      const diagnoses: ModelDiagnosis[] = [
        {
          model: 'claude-sonnet-5',
          provider: 'anthropic',
          tiers: ['checker', 'worker_fallback'],
          reachable: true,
          experimental: false,
          reason: 'ok (claude CLI)',
        },
      ];
      expect(hasReachableWorker(diagnoses)).toBe(true);
    });
  });

  describe('constitution scaffolder', () => {
    const TEMPLATE = `# Constitution Template

Some prose about writing a constitution.

## Format

\`\`\`markdown
---
product: <product-name>
version: 1
checkers:
  - example-checker
enforced_on: [plan, build, check]
---

# <Product> Constitution

## Purpose
<One paragraph>

## Standards

## Quality Gates

## Dispute Rules

## Non-Goals
\`\`\`

## Writing a Constitution

More prose here.
`;

    it('scaffoldConstitution fills the product name in', () => {
      const result = scaffoldConstitution(TEMPLATE, 'acme-app');
      expect(result).toContain('product: "acme-app"');
      expect(result).toContain('# Acme App Constitution');
      expect(result).not.toContain('<product-name>');
      expect(result).not.toContain('<Product>');
    });

    it('scaffoldConstitution quotes an all-digit product name so YAML parses it as a string', () => {
      const result = scaffoldConstitution(TEMPLATE, '2024');
      expect(result).toContain('product: "2024"');
    });

    it('scaffoldConstitution collapses repeated/trailing separators without stray spaces in the heading', () => {
      expect(scaffoldConstitution(TEMPLATE, 'acme--app')).toContain('# Acme App Constitution');
      expect(scaffoldConstitution(TEMPLATE, 'acme-')).toContain('# Acme Constitution');
    });

    it('scaffoldConstitution extracts the skeleton, not the surrounding docs', () => {
      const result = scaffoldConstitution(TEMPLATE, 'acme-app');
      expect(result).not.toContain('Writing a Constitution');
    });

    it('scaffoldConstitution throws when no ```markdown block exists', () => {
      expect(() => scaffoldConstitution('# just some docs, no fenced block', 'acme-app')).toThrow();
    });

    it('assertValidProduct rejects unsafe names and accepts normal ones', () => {
      expect(() => assertValidProduct('../evil')).toThrow(InvalidProductNameError);
      expect(() => assertValidProduct('_reserved')).toThrow(InvalidProductNameError);
      expect(() => assertValidProduct('a/b')).toThrow(InvalidProductNameError);
      expect(() => assertValidProduct('acme-app')).not.toThrow();
    });
  });

  describe('readActiveProduct', () => {
    it('returns the trimmed product name when the file exists', () => {
      expect(
        readActiveProduct('/repo/.factory/product', {
          fileExists: () => true,
          readFile: () => 'alpha\n',
        }),
      ).toBe('alpha');
    });

    it('returns undefined when the file is missing', () => {
      expect(readActiveProduct('/repo/.factory/product', { fileExists: () => false })).toBeUndefined();
    });

    it('returns undefined when the file contains only whitespace', () => {
      expect(
        readActiveProduct('/repo/.factory/product', {
          fileExists: () => true,
          readFile: () => '  \n\t ',
        }),
      ).toBeUndefined();
    });
  });

  describe('publish contract', () => {
    it('PREREQUISITES_TEXT mentions all three prerequisites', () => {
      expect(PREREQUISITES_TEXT).toMatch(/Claude/);
      expect(PREREQUISITES_TEXT).toMatch(/gh auth/);
      expect(PREREQUISITES_TEXT).toMatch(/GITHUB_TOKEN/);
    });

    it('HELP_FOOTER_TEXT points at the config reference, per-command help, and the docs', () => {
      expect(HELP_FOOTER_TEXT).toContain('Common environment variables:');
      expect(HELP_FOOTER_TEXT).toContain('FACTORY_MERGE=1');
      expect(HELP_FOOTER_TEXT).toContain('docs/config.example.yaml');
      expect(HELP_FOOTER_TEXT).toContain('factory <command> --help');
      expect(HELP_FOOTER_TEXT).toContain('https://github.com/on-par/software-factory#readme');
    });

    it('pins the publish-critical fields of package.json', () => {
      const cliPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
      expect(cliPkg.files).toEqual(['dist', 'schemas', '!dist/.tsbuildinfo']);
      expect(cliPkg.publishConfig.access).toBe('public');
      expect(cliPkg.bin.factory).toBe('dist/cli.js');
      expect(typeof cliPkg.version).toBe('string');
      expect(cliPkg.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('registers the version from package.json (no hardcoded duplicate)', () => {
      const cliPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
      expect(getCliVersion()).toBe(cliPkg.version);
    });
  });

  describe('resume-approved sweep', () => {
    describe('issueFromFactoryBranch', () => {
      it('parses the issue number out of a factory branch name', () => {
        expect(issueFromFactoryBranch('ship-it/154-land-awaiting')).toBe(154);
        expect(issueFromFactoryBranch('ship-it/7-')).toBe(7);
      });

      it('recognizes the factory default, a custom prefix, and legacy ship-it', () => {
        expect(issueFromFactoryBranch('factory/9-a', 'factory')).toBe(9);
        expect(issueFromFactoryBranch('sf/9-a', 'sf')).toBe(9);
        expect(issueFromFactoryBranch('ship-it/9-a', 'sf')).toBe(9);
        expect(issueFromFactoryBranch('factory/9-a', 'sf')).toBeUndefined();
      });

      it('returns undefined for branches without a leading issue number', () => {
        expect(issueFromFactoryBranch('ship-it/abc-x')).toBeUndefined();
        expect(issueFromFactoryBranch('main')).toBeUndefined();
      });
    });

    describe('listOpenFactoryPRs', () => {
      it('keeps factory/* and legacy ship-it/* branches and drops the rest', async () => {
        const octokit: any = {
          graphql: vi.fn(async () => ({
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { number: 1, headRefName: 'factory/1-a' },
                  { number: 2, headRefName: 'ship-it/2-b' },
                  { number: 3, headRefName: 'chore/3-c' },
                  { number: 4, headRefName: 'sf/4-d' },
                ],
              },
            },
          })),
        };
        const result = await listOpenFactoryPRs(octokit, 'o', 'r', 'factory');
        expect(result.map((p) => p.number)).toEqual([1, 2]);
        const custom = await listOpenFactoryPRs(octokit, 'o', 'r', 'sf');
        expect(custom.map((p) => p.number)).toEqual([2, 4]);
      });

      it('filters to ship-it/* branches and paginates through every page', async () => {
        const calls: any[] = [];
        const octokit: any = {
          graphql: vi.fn(async (_query: string, vars: any) => {
            calls.push(vars);
            if (!vars.cursor) {
              return {
                repository: {
                  pullRequests: {
                    pageInfo: { hasNextPage: true, endCursor: 'CURSOR1' },
                    nodes: [
                      { number: 1, headRefName: 'ship-it/1-a', reviewDecision: 'APPROVED', isDraft: false },
                      { number: 2, headRefName: 'chore/unrelated', reviewDecision: null, isDraft: false },
                    ],
                  },
                },
              };
            }
            return {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ number: 3, headRefName: 'ship-it/3-b', reviewDecision: 'REVIEW_REQUIRED', isDraft: true }],
                },
              },
            };
          }),
        };

        const result = await listOpenFactoryPRs(octokit, 'on-par', 'software-factory');

        expect(result).toEqual([
          { number: 1, branch: 'ship-it/1-a', reviewDecision: 'APPROVED', isDraft: false },
          { number: 3, branch: 'ship-it/3-b', reviewDecision: 'REVIEW_REQUIRED', isDraft: true },
        ]);
        expect(calls).toHaveLength(2);
        expect(calls[0].cursor).toBeUndefined();
        expect(calls[1].cursor).toBe('CURSOR1');
      });
    });

    describe('sweepApprovedPRs', () => {
      const repoRoot = '/repo';
      const ghRepo = 'on-par/software-factory';
      const paths: any = { events: '/repo/.factory/events.ndjson', mergeLock: '/repo/.factory/merge.lock' };
      const octokit: any = { fake: 'octokit' };
      const fakeFactoryConfig: any = { merge: { auto: true, comment: '' }, ci: { skip: false, comment: '' } };

      it('lands an approved PR through the existing serialized merge path', async () => {
        const calls: any[] = [];
        const result = await sweepApprovedPRs(repoRoot, ghRepo, paths, {
          createOctokit: () => octokit,
          loadConfig: () => fakeFactoryConfig,
          listPRs: async () => [{ number: 320, branch: 'ship-it/12-x', reviewDecision: 'APPROVED' }],
          land: async (...args: any[]) => {
            calls.push(['land', args]);
            return { branch: 'ship-it/12-x', prNumber: 320 };
          },
          emitEvent: (eventsFile: string, type: string, issue: string | number, msg: string) =>
            calls.push(['event', eventsFile, type, issue, msg]),
          writeLine: (line: string) => calls.push(['writeLine', line]),
        });

        expect(calls[0]).toEqual(['land', [12, repoRoot, ghRepo, paths, octokit, false, undefined]]);
        expect(result.landed).toEqual([320]);
        expect(result.skipped).toEqual([]);
        expect(result.failed).toEqual([]);

        const events = calls.filter((c) => c[0] === 'event');
        expect(events).toHaveLength(1);
        expect(events[0][2]).toBe('resume-approved');
        expect(events[0][3]).toBe('-');
        expect(events[0][4]).toBe('sweep: 1 landed, 0 skipped, 0 failed of 1 open factory PRs');
      });

      it('lands approved PRs on both the factory and legacy ship-it prefixes', async () => {
        const landCalls: any[] = [];
        const listCalls: any[] = [];
        const result = await sweepApprovedPRs(
          repoRoot,
          ghRepo,
          paths,
          {
            createOctokit: () => octokit,
            loadConfig: () => fakeFactoryConfig,
            listPRs: async (...args: any[]) => {
              listCalls.push(args);
              return [
                { number: 40, branch: 'factory/30-x', reviewDecision: 'APPROVED' },
                { number: 41, branch: 'ship-it/31-y', reviewDecision: 'APPROVED' },
              ];
            },
            land: async (...args: any[]) => {
              landCalls.push(args);
              return { branch: '', prNumber: 0 };
            },
            emitEvent: () => {},
            writeLine: () => {},
          },
          { branchPrefix: 'factory' },
        );

        expect(result.landed).toEqual([40, 41]);
        expect(landCalls.map((c) => [c[0], c[6]])).toEqual([
          [30, 'factory'],
          [31, 'factory'],
        ]);
        expect(listCalls[0][3]).toBe('factory');
      });

      it('skips unapproved and unparseable PRs without landing or throwing, idempotently', async () => {
        const landCalls: any[] = [];
        const deps = {
          createOctokit: () => octokit,
          loadConfig: () => fakeFactoryConfig,
          listPRs: async () => [
            { number: 1, branch: 'ship-it/1-a', reviewDecision: 'REVIEW_REQUIRED' },
            { number: 2, branch: 'ship-it/2-b', reviewDecision: undefined },
            { number: 3, branch: 'ship-it/x-bad', reviewDecision: 'APPROVED' },
          ],
          land: async (...args: any[]) => {
            landCalls.push(args);
            return { branch: '', prNumber: 0 };
          },
          emitEvent: () => {},
          writeLine: () => {},
        };

        const run1 = await sweepApprovedPRs(repoRoot, ghRepo, paths, deps);
        const run2 = await sweepApprovedPRs(repoRoot, ghRepo, paths, deps);

        expect(landCalls).toEqual([]);
        expect(run1.landed).toEqual([]);
        expect(run1.skipped).toEqual([
          { pr: 1, branch: 'ship-it/1-a', reason: 'not approved (reviewDecision: REVIEW_REQUIRED)' },
          { pr: 2, branch: 'ship-it/2-b', reason: 'not approved (reviewDecision: none)' },
          { pr: 3, branch: 'ship-it/x-bad', reason: 'no issue number in branch' },
        ]);
        expect(run1.failed).toEqual([]);
        expect(run2).toEqual(run1);
      });

      it('does not abort the sweep when one landing attempt fails', async () => {
        const landed: number[] = [];
        const events: any[] = [];
        const result = await sweepApprovedPRs(repoRoot, ghRepo, paths, {
          createOctokit: () => octokit,
          loadConfig: () => fakeFactoryConfig,
          listPRs: async () => [
            { number: 10, branch: 'ship-it/10-a', reviewDecision: 'APPROVED' },
            { number: 11, branch: 'ship-it/11-b', reviewDecision: 'APPROVED' },
          ],
          land: async (issueNum: number) => {
            if (issueNum === 10) throw new LandConflictError('land sync conflict on ship-it/10-a — parked');
            landed.push(issueNum);
            return { branch: 'ship-it/11-b', prNumber: 11 };
          },
          emitEvent: (_eventsFile: string, type: string, issue: string | number, msg: string) =>
            events.push([type, issue, msg]),
          writeLine: () => {},
        });

        expect(landed).toEqual([11]);
        expect(result.landed).toEqual([11]);
        expect(result.skipped).toEqual([]);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]).toMatchObject({ pr: 10, issue: 10 });
        expect(result.failed[0].reason).toContain('land sync conflict');

        const summary = events.find((e) => e[0] === 'resume-approved');
        expect(summary).toBeDefined();
        expect(summary[2]).toBe('sweep: 1 landed, 0 skipped, 1 failed of 2 open factory PRs');
      });
    });
  });
});

describe('withRepoRunLock', () => {
  const paths = getFactoryPaths('/repo');

  it('returns the wrapped function value when the lock is free', async () => {
    const result = await withRepoRunLock(paths, 'factory run', async () => 'ok', {
      runLock: async (_dir, fn) => fn(),
    });

    expect(result).toBe('ok');
  });

  it('maps RunLockHeldError to a CliExitError(2) naming the holder and remedy, and records run_lock_conflict', async () => {
    const events: any[] = [];
    const holder = { pid: 4321, command: 'factory run', startedAt: '2026-01-01T00:00:00.000Z', host: 'other-host' };

    let rejection: unknown;
    try {
      await withRepoRunLock(paths, 'factory run-issue', async () => 'unreachable', {
        runLock: async () => {
          throw new RunLockHeldError(paths.runLock, holder);
        },
        emitEvent: (eventsFile, type, issue, msg) => {
          events.push({ eventsFile, type, issue, msg });
        },
      });
    } catch (err) {
      rejection = err;
    }

    expect(rejection).toBeInstanceOf(CliExitError);
    const exitErr = rejection as CliExitError;
    expect(exitErr.code).toBe(2);
    expect(exitErr.message).toContain('4321');
    expect(exitErr.message).toContain('stop that run');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventsFile: paths.events, type: 'run_lock_conflict' });
  });

  it('passes through a non-RunLockHeldError failure unchanged, without emitting an event', async () => {
    const emitEvent = vi.fn();

    await expect(
      withRepoRunLock(paths, 'factory run', async () => 'unreachable', {
        runLock: async () => {
          throw new Error('boom');
        },
        emitEvent,
      }),
    ).rejects.toThrow('boom');

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('emits lock-stolen through emitEvent when the injected runLock reclaims a dead holder', async () => {
    const events: any[] = [];

    await withRepoRunLock(paths, 'factory supervise', async () => 'ok', {
      runLock: async (_dir, fn, opts: any) => {
        opts.onReclaim(4321);
        return fn();
      },
      emitEvent: (eventsFile, type, issue, msg) => {
        events.push({ eventsFile, type, issue, msg });
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventsFile: paths.events, type: 'lock-stolen' });
    expect(events[0].msg).toContain('4321');
  });
});

describe('runFeedbackCommand (#1851)', () => {
  const deps = (over: Record<string, unknown> = {}): any => ({
    github: {
      getPull: async () => ({ headRef: 'x', title: 't', url: 'u' }),
      listReviews: async () => [],
      listReviewComments: async () => [],
    },
    filing: {
      listCandidateIssues: async () => [],
      searchIssues: async () => [],
      createIssue: async () => ({ number: 9 }),
      updateIssue: async () => {},
      commentIssue: async () => {},
    },
    paths: { events: '/nowhere/events', plans: '/p', logs: '/l' },
    now: () => new Date(0),
    host: 'h',
    repo: 'acme/tools',
    ...over,
  });

  it('prints the filed issue', async () => {
    const lines: string[] = [];
    await runFeedbackCommand('https://github.com/o/r/pull/1', { note: 'gap' }, deps(), (l) => lines.push(l));
    expect(lines).toEqual(['Filed acme/tools#9']);
  });

  it('maps a missing target repo to exit 2', async () => {
    await expect(
      runFeedbackCommand('https://github.com/o/r/pull/1', { note: 'gap' }, deps({ repo: undefined })),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('cmdFeedback rejects a malformed --repo with exit 2', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    try {
      await expect(cmdFeedback('https://github.com/o/r/pull/1', { repo: 'nope' })).rejects.toMatchObject({
        code: 2,
        message: expect.stringContaining('--repo must be owner/name'),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('readOriginSlug parses the origin remote and never throws', async () => {
    const ok: any = { exec: async () => ({ stdout: 'git@github.com:acme/tools.git\n' }) };
    expect(await readOriginSlug(ok)).toBe('acme/tools');
    const fail: any = {
      exec: async () => {
        throw new Error('no origin');
      },
    };
    expect(await readOriginSlug(fail)).toBeNull();
  });

  it('maps validation errors to exit 2', async () => {
    await expect(runFeedbackCommand('bogus', {}, deps())).rejects.toMatchObject({ code: 2 });
  });

  it('rethrows other errors untouched', async () => {
    const d = deps({
      github: {
        getPull: async () => {
          throw new Error('boom');
        },
      },
    });
    await expect(runFeedbackCommand('https://github.com/o/r/pull/1', {}, d)).rejects.toThrow('boom');
  });

  it('cmdFeedback wires real deps and refuses an invalid URL before any network call', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    try {
      await expect(cmdFeedback('bogus', {})).rejects.toMatchObject({ code: 2 });
      await expect(cmdFeedback('bogus', { branchPrefix: 'ship-it' })).rejects.toMatchObject({ code: 2 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('cmdFilingPreview (#1858)', () => {
  it('exits 2 when no failure evidence matches the run id, with and without a branch prefix', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(cmdFilingPreview('no-such-run-1858', {})).rejects.toMatchObject({ code: 2 });
      await expect(cmdFilingPreview('no-such-run-1858', { branchPrefix: 'ship-it' })).rejects.toMatchObject({
        code: 2,
      });
    } finally {
      stderr.mockRestore();
    }
  });
});
