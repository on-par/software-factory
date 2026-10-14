// packages/cli/src/cli/run.test.ts — factory run tests, moved from cli-commands.test.ts (#2800)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  coreFakes,
  errored,
  h,
  installShipHarness,
  logged,
  ops,
  paths,
  runMainWith,
  trackEnv,
} from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli', () => {
  describe('run', () => {
    it('names the branch with the default factory prefix when --branch-prefix is omitted', async () => {
      writeFileSync(paths().queue, '# header\napp 5\n');
      const branches: string[] = [];
      h.setupWorktreeImpl = async (_r, branch) => {
        branches.push(branch);
      };
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);
      expect(branches[0]).toEqual(expect.stringMatching(/^factory\/\d+-/));
    });

    it('names the branch and worktree with --branch-prefix sf', async () => {
      writeFileSync(paths().queue, '# header\napp 5\n');
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('run', '--local-queue', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toEqual(expect.stringMatching(/^sf\/\d+-/));
      expect(calls[0][1]).toContain('-factory-sf-');
    });
    it('exits 2 when the queue file is missing', async () => {
      rmSync(paths().queue, { force: true });
      const res = await runMain('run', '--local-queue');
      expect(res).toEqual({ exited: true, code: 2 });
    });

    it('skips claiming new work and leaves .factory/STOP in place when STOP is present at the top of a run', async () => {
      writeFileSync(paths().queue, '# header\napp 1\napp 2\ndocs 3\n');
      writeFileSync(paths().stop, '');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().stop)).toBe(true);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('"type":"stopped"');
      expect(events).not.toContain('run-done');
      expect(logged() + errored()).toContain('.factory/STOP present');
    });

    it('runs worktree gc before lanes when worktree.autoGcOnRun is true', async () => {
      h.factoryConfig = {
        merge: { auto: false, comment: '' },
        worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: true },
      };
      writeFileSync(paths().queue, '# header\napp 1\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, repo: h.ghRepo }),
        expect.objectContaining({ octokit: expect.anything() }),
      );
      expect(ops.formatGcReport).toHaveBeenCalled();
    });

    it('does not run worktree gc when worktree.autoGcOnRun is false', async () => {
      h.factoryConfig = {
        merge: { auto: false, comment: '' },
        worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: false },
      };
      writeFileSync(paths().queue, '# header\napp 1\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).not.toHaveBeenCalled();
    });

    it('proceeds with the run even when worktree gc rejects', async () => {
      h.factoryConfig = {
        merge: { auto: false, comment: '' },
        worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: true },
      };
      ops.sweepWorktrees.mockRejectedValueOnce(new Error('gc boom'));
      writeFileSync(paths().queue, '# header\napp 1\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('gc boom');
      expect(events).toContain('run-done');
    });

    it('skips malformed queue lines, starts lanes only for valid entries, and warns', async () => {
      writeFileSync(paths().queue, '# header\napp 1\napp abc\ndocs 3\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);
      const err = errored();
      expect(err).toContain('malformed');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain(`lane 'app' started (1 issues)`);
      expect(events).toContain(`lane 'docs' started (1 issues)`);
      expect(events).toContain('run-done');
      expect(events + err).not.toContain('NaN');
    });

    it('skips starting the usage watchdog when FACTORY_USAGE_WATCH=0', async () => {
      trackEnv('FACTORY_USAGE_WATCH');
      process.env.FACTORY_USAGE_WATCH = '0';
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('run-done');
    });

    it('passes the non-Claude harness to the usage watchdog for an opencode route with a non-Claude plan pin', async () => {
      mkdirSync(paths().root, { recursive: true });
      writeFileSync(paths().config, JSON.stringify({ version: 2, route: 'opencode' }));
      h.modelOverrides = { plan: 'opencode-deepseek-v4-flash' };
      const original = coreFakes.ModelRegistry.getMockImplementation();
      coreFakes.ModelRegistry.mockImplementation(function (this: unknown, ...args: unknown[]) {
        return { ...(original as any).apply(this, args), getHarnessId: () => 'opencode' };
      } as never);
      try {
        writeFileSync(paths().queue, 'app 1\n');
        const res = await runMain('run', '--local-queue');
        expect(res.exited).toBe(false);
        expect(coreFakes.watchUsage).toHaveBeenCalledWith(expect.objectContaining({ harness: 'opencode' }));
      } finally {
        coreFakes.ModelRegistry.mockImplementation(original as never);
      }
    });

    it('passes no harness to the usage watchdog when the run is not resolved as non-Claude', async () => {
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);
      expect(coreFakes.watchUsage).toHaveBeenCalled();
      expect(coreFakes.watchUsage.mock.calls.at(-1)?.[0]).not.toHaveProperty('harness');
    });

    it('logs a warn event without crashing the run when the usage watchdog rejects', async () => {
      coreFakes.watchUsage.mockRejectedValueOnce(new Error('watchdog exploded'));
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('usage watchdog crashed');
      expect(events).toContain('watchdog exploded');
    });

    it('appends a KPI snapshot with the HEAD commit sha and resolved models when the queue has issues', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse HEAD')) return 'deadbeef';
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);

      expect(existsSync(paths().kpiHistory)).toBe(true);
      const lines = readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.commitSha).toBe('deadbeef');
      expect(record).toHaveProperty('models');

      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('kpi-snapshot');
    });

    it('run: the post-run KPI snapshot counts an admin-merged PR reconstructed from GitHub (#2342)', async () => {
      writeFileSync(paths().queue, 'app 1\n');
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) =>
        state === 'all'
          ? {
              data: [
                {
                  number: 5,
                  head: { ref: 'factory/1-fix-it' },
                  state: 'closed',
                  merged_at: new Date().toISOString(),
                  closed_at: null,
                },
              ],
            }
          : { data: [] },
      );
      h.octokit.rest.pulls.listCommits = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.listReviews = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.get = vi.fn(async () => ({ data: { merged_by: { login: 'patrob' } } }));
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);

      const record = JSON.parse(readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n')[0]);
      expect(record.mergeRate).toBeGreaterThan(0);
      expect(record).not.toHaveProperty('partial');
    });

    it('run: a GitHub failure during the post-run reconstruction marks the snapshot partial (#2342)', async () => {
      writeFileSync(paths().queue, 'app 1\n');
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) => {
        if (state === 'all') throw new Error('boom');
        return { data: [] };
      });
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);

      const record = JSON.parse(readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n')[0]);
      expect(record.partial).toBe(true);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('kpi snapshot partial');
      expect(events).toContain('run-done');
    });

    it('appends a second KPI snapshot on a second run', async () => {
      writeFileSync(paths().queue, 'app 1\n');
      await runMain('run', '--local-queue');
      await runMain('run', '--local-queue');

      const lines = readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });

    it('does not create a KPI snapshot when the queue has no entries', async () => {
      writeFileSync(paths().queue, '# header\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);

      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('run-done');
      expect(events).not.toContain('kpi-snapshot');
      expect(existsSync(paths().kpiHistory)).toBe(false);
    });

    it('does not fail the run when the KPI snapshot git lookup fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse HEAD')) throw new Error('git exploded');
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      writeFileSync(paths().queue, 'app 1\n');
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);

      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('run-done');
      expect(events).toContain('kpi-snapshot');
      const lines = readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.commitSha).toBeNull();
    });

    it('does not fail the run when the KPI history path cannot be read for a reason other than "missing"', async () => {
      writeFileSync(paths().queue, 'app 1\n');
      mkdirSync(paths().kpiHistory);
      const res = await runMain('run', '--local-queue');
      expect(res.exited).toBe(false);

      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('run-done');
      expect(events).toContain('kpi snapshot failed');
    });

    it('without --local-queue, discovers lanes from GitHub Issues instead of the queue file, and finishes cleanly when nothing is queued', async () => {
      rmSync(paths().queue, { force: true });
      const res = await runMain('run');
      expect(res.exited).toBe(false);
      expect(h.octokit.rest.issues.listForRepo).toHaveBeenCalled();
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('run-done');
      expect(events).not.toContain('kpi-snapshot');
    });

    it('auto-merge flag: factory run --auto-merge records the positive override in run-flags.json', async () => {
      writeFileSync(paths().queue, '# header\n');
      const res = await runMain('run', '--local-queue', '--auto-merge');
      expect(res.exited).toBe(false);
      expect(JSON.parse(readFileSync(paths().runFlags, 'utf-8'))).toEqual({ autoMerge: true });
    });

    it('auto-merge flag: factory run --no-auto-merge records the negative override in run-flags.json', async () => {
      writeFileSync(paths().queue, '# header\n');
      const res = await runMain('run', '--local-queue', '--no-auto-merge');
      expect(res.exited).toBe(false);
      expect(JSON.parse(readFileSync(paths().runFlags, 'utf-8'))).toEqual({ autoMerge: false });
    });

    it('usage-watch flag: factory run --no-usage-watch logs the flag as the override source', async () => {
      writeFileSync(paths().queue, '# header\n');
      const res = await runMain('run', '--local-queue', '--no-usage-watch');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('usage watchdog disabled by flag: --no-usage-watch');
      expect(readFileSync(paths().events, 'utf-8')).toContain('usage watchdog disabled by flag: --no-usage-watch');
    });

    it('usage threshold and poll flags: factory run wires flag values and logs their sources', async () => {
      trackEnv('FACTORY_STOP_AT', 'FACTORY_USAGE_POLL');
      process.env.FACTORY_STOP_AT = '0.5';
      process.env.FACTORY_USAGE_POLL = '60';
      writeFileSync(paths().queue, '# header\n');
      const res = await runMain('run', '--local-queue', '--usage-threshold', '0.7', '--usage-poll', '15');
      expect(res.exited).toBe(false);
      expect(coreFakes.watchUsage).toHaveBeenCalledWith(expect.objectContaining({ stopAt: 0.7, pollMs: 15_000 }));
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('flag: --usage-threshold');
      expect(events).toContain('flag: --usage-poll');
    });

    it('usage threshold and poll flags: invalid factory run values name the offending flag', async () => {
      writeFileSync(paths().queue, '# header\n');
      const res = await runMain('run', '--local-queue', '--usage-threshold', '0');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--usage-threshold');
    });

    it('auto-merge flag: a later flagless factory run clears the recorded override', async () => {
      writeFileSync(paths().queue, '# header\n');
      await runMain('run', '--local-queue', '--auto-merge');
      expect(existsSync(paths().runFlags)).toBe(true);
      await runMain('run', '--local-queue');
      expect(existsSync(paths().runFlags)).toBe(false);
    });

    describe('macOS keychain preflight (#1014)', () => {
      let originalPlatform: NodeJS.Platform;

      beforeEach(() => {
        trackEnv('TMUX', 'ANTHROPIC_API_KEY');
        originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        h.claudeAvailable = true;
        delete process.env.TMUX;
        delete process.env.ANTHROPIC_API_KEY;
        writeFileSync(paths().queue, 'app 1\n');
      });

      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      });

      it('aborts before claiming any issue when the keychain is unreadable inside tmux', async () => {
        process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
        h.execSyncImpl = (cmd: string) => {
          if (cmd.includes('find-generic-password')) throw new Error('SecKeychainSearchCopyNext: exit 44');
          return '';
        };
        await expect(runMain('run', '--local-queue')).rejects.toThrow(/tmux/);
        const events = readFileSync(paths().events, 'utf-8');
        expect(events).toContain('environment_warning');
        expect(events).toContain('local_auth');
        expect(events).not.toContain(`lane 'app' started`);
      });

      it('warns but proceeds when the keychain is unreadable outside tmux', async () => {
        h.execSyncImpl = (cmd: string) => {
          if (cmd.includes('find-generic-password')) throw new Error('SecKeychainSearchCopyNext: exit 44');
          return '';
        };
        const res = await runMain('run', '--local-queue');
        expect(res.exited).toBe(false);
        const events = readFileSync(paths().events, 'utf-8');
        expect(events).toContain('run-done');
      });

      it('proceeds when the login keychain entry is readable', async () => {
        h.execSyncImpl = () => '';
        const res = await runMain('run', '--local-queue');
        expect(res.exited).toBe(false);
        const events = readFileSync(paths().events, 'utf-8');
        expect(events).toContain('run-done');
      });

      it('skips the probe when the claude CLI is not on PATH', async () => {
        h.claudeAvailable = false;
        h.execSyncImpl = () => {
          throw new Error('security should not be invoked when claude is unavailable');
        };
        const res = await runMain('run', '--local-queue');
        expect(res.exited).toBe(false);
        const events = readFileSync(paths().events, 'utf-8');
        expect(events).toContain('run-done');
      });

      it('skips the probe when ANTHROPIC_API_KEY auth is in use', async () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
        h.execSyncImpl = () => {
          throw new Error('security should not be invoked when using ANTHROPIC_API_KEY');
        };
        const res = await runMain('run', '--local-queue');
        expect(res.exited).toBe(false);
        const events = readFileSync(paths().events, 'utf-8');
        expect(events).toContain('run-done');
      });
    });
  });
});
