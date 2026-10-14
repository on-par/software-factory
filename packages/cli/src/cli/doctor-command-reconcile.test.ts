// packages/cli/src/cli/doctor-command-reconcile.test.ts — factory doctor --reconcile, lease and orphan row tests, moved from cli-commands.test.ts (#2799)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { microVmName } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { h, installDoctorHarness, logged, ops, paths, runMainWith } from './test-support/doctor-harness.js';

installDoctorHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli', () => {
  describe('doctor', () => {
    beforeEach(() => {
      // Never read the real ~/.codex/auth.json from doctor tests (#2509).
      vi.stubEnv('CODEX_HOME', join(h.repoRoot, 'no-codex-home'));
      // Keep real credentials out of the sign-in evidence checks (#2556).
      mkdirSync(join(h.repoRoot, 'no-claude-config'), { recursive: true });
      mkdirSync(join(h.repoRoot, 'no-xdg-data'), { recursive: true });
      vi.stubEnv('CLAUDE_CONFIG_DIR', join(h.repoRoot, 'no-claude-config'));
      vi.stubEnv('XDG_DATA_HOME', join(h.repoRoot, 'no-xdg-data'));
      for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'OPENCODE_API_KEY']) {
        vi.stubEnv(key, '');
      }
      // Green doctor tests need at least one signed-in agent (#2556); agent sign-in cases override via withAuth.
      writeFileSync(join(h.repoRoot, 'no-claude-config', '.credentials.json'), '{}');
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('status --porcelain')) return '';
        if (cmd.includes('git config user.name')) return 'Test User';
        if (cmd.includes('git config user.email')) return 'test@example.com';
        if (cmd.includes('gh auth token')) return 'gho_token';
        if (cmd.includes('gh auth status')) return 'Logged in';
        return '';
      };
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('reports a live and a stale port lease without failing doctor', async () => {
      h.claudeAvailable = true;
      const portsFile = join(h.repoRoot, '.factory', 'state', 'ports.json');
      writeFileSync(
        portsFile,
        JSON.stringify({
          version: 1,
          leases: [
            {
              worktreeId: h.repoRoot,
              branch: 'live',
              port: 4001,
              pid: process.pid,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
            {
              worktreeId: '/nonexistent/wt',
              branch: 'gone',
              port: 4002,
              pid: 2 ** 30,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );

      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('port lease :4001');
      expect(logged()).toContain('port lease :4002');
      expect(logged()).toContain('--reconcile');
    });

    it('--reconcile removes stale leases and reports freed ports', async () => {
      h.claudeAvailable = true;
      const portsFile = join(h.repoRoot, '.factory', 'state', 'ports.json');
      writeFileSync(
        portsFile,
        JSON.stringify({
          version: 1,
          leases: [
            {
              worktreeId: h.repoRoot,
              branch: 'live',
              port: 4001,
              pid: process.pid,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
            {
              worktreeId: '/nonexistent/wt',
              branch: 'gone',
              port: 4002,
              pid: 2 ** 30,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );

      const res = await runMain('doctor', '--reconcile');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('reconcile: freed port 4002');

      const registry = JSON.parse(readFileSync(portsFile, 'utf-8'));
      expect(registry.leases).toHaveLength(1);
      expect(registry.leases[0].port).toBe(4001);
    });

    it('--reconcile prints orphan-reaper events for the freed lease', async () => {
      h.claudeAvailable = true;
      const portsFile = join(h.repoRoot, '.factory', 'state', 'ports.json');
      writeFileSync(
        portsFile,
        JSON.stringify({
          version: 1,
          leases: [
            {
              worktreeId: '/nonexistent/wt',
              branch: 'gone',
              port: 4002,
              pid: 2 ** 30,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );
      h.orphanEvents = [
        { action: 'reported', worktreeId: '/nonexistent/wt', port: 4002, pid: 55, pgid: 66, command: 'stray-proc' },
      ];

      const res = await runMain('doctor', '--reconcile');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('reconcile: freed port 4002');
      expect(logged()).toContain(
        'reconcile: found pid 55 (pgid 66, stray-proc) squatting port 4002 of dead lane /nonexistent/wt; not factory-started, left running',
      );
    });

    it('reports event log corruption count and percentage', async () => {
      h.claudeAvailable = true;
      writeFileSync(
        paths().events,
        ['{"ts":"1"}', '{"ts":"2"}', '{"ts":"3"}', '{"ts":"4"}', 'not json'].join('\n') + '\n',
      );

      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('unparseable');
      expect(logged()).toContain('(20.0%)');
    });

    it('--reconcile sweeps dead-run worktrees and reports them', async () => {
      h.claudeAvailable = true;
      h.gcReport = {
        removed: [
          {
            path: '/wt/a',
            branch: 'ship-it/5-x',
            ageDays: 1,
            reason: 'merged',
            scrubbedFiles: [],
            branchDeleted: true,
          },
        ],
        kept: 0,
        dryRun: false,
      };

      const res = await runMain('doctor', '--reconcile');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7 }),
        expect.anything(),
      );
      expect(logged()).toContain('reconcile: removed worktree /wt/a');
      expect(logged()).toContain('deleted branch ship-it/5-x');
    });

    it('doctor without --reconcile never sweeps worktrees', async () => {
      h.claudeAvailable = true;
      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).not.toHaveBeenCalled();
    });

    it('--reconcile survives a failing worktree sweep', async () => {
      h.claudeAvailable = true;
      ops.sweepWorktrees.mockRejectedValueOnce(new Error('gc boom'));
      const res = await runMain('doctor', '--reconcile');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('reconcile: worktree sweep failed');
    });

    it('--reconcile releases stale claims and reports them', async () => {
      h.claudeAvailable = true;
      h.staleClaims = [
        { issue: 42, label: 'factory:claim-expires:1700000000', expiresAt: 1_700_000_000, released: true },
      ];

      const res = await runMain('doctor', '--reconcile');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('reconcile: released issue #42 back to factory:queued');
    });

    it('doctor without --reconcile never calls releaseStaleClaims', async () => {
      h.claudeAvailable = true;
      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(ops.releaseStaleClaims).not.toHaveBeenCalled();
    });

    it('--reconcile survives a rejected releaseStaleClaims', async () => {
      h.claudeAvailable = true;
      ops.releaseStaleClaims.mockRejectedValueOnce(new Error('claims boom'));
      const res = await runMain('doctor', '--reconcile');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('reconcile: stale claim release failed');
    });

    it('--reconcile skips stale claims when no GitHub token is available', async () => {
      h.claudeAvailable = true;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('status --porcelain')) return '';
        if (cmd.includes('gh auth token')) throw new Error('not logged in');
        if (cmd.includes('gh auth status')) throw new Error('not logged in');
        return '';
      };
      await runMain('doctor', '--reconcile');
      expect(logged()).toContain('reconcile: skipping stale claims: no GitHub repo or token');
      expect(ops.releaseStaleClaims).not.toHaveBeenCalled();
    });

    it('reports a green-and-ready PR with its owning issue', async () => {
      h.claudeAvailable = true;
      h.greenPrs = [{ number: 957, branch: 'ship-it/939-x', title: 't', issue: 939, ageHours: 9 }];

      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('green PR #957');
      expect(logged()).toContain('issue #939');
    });

    it('reports no green-and-ready PRs when there are none', async () => {
      h.claudeAvailable = true;
      h.greenPrs = [];

      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('no green-and-ready PRs awaiting merge');
    });

    it('skips the orphan container/sbx VM scan entirely when docker/sbx are not on PATH', async () => {
      h.claudeAvailable = true;

      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(ops.listOrphanContainers).not.toHaveBeenCalled();
      expect(ops.listMicroVms).not.toHaveBeenCalled();
      expect(logged()).toContain('no orphan sf-job-*/factory.managed containers');
      expect(logged()).toContain('no orphan factory-* sbx VMs');
    });

    it('fails doctor and reports each stopped sf-job-*/factory.managed container as an orphan', async () => {
      h.claudeAvailable = true;
      h.dockerAvailable = true;
      h.orphanContainers = [{ id: 'abc123', name: 'sf-job-1' }];

      const res = await runMain('doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('orphan container sf-job-1');
      expect(logged()).toContain('is stopped and not tied to any running job');
    });

    it('--reconcile reaps orphan containers and reports the outcome', async () => {
      h.claudeAvailable = true;
      h.dockerAvailable = true;
      h.orphanContainers = [{ id: 'abc123', name: 'sf-job-1' }];
      h.reapedContainers = [{ id: 'abc123', name: 'sf-job-1', removed: true, detail: 'docker rm -f -v sf-job-1 ok' }];

      const res = await runMain('doctor', '--reconcile');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(ops.reapOrphanContainers).toHaveBeenCalledWith(h.orphanContainers);
      expect(logged()).toContain('reconcile: removed container sf-job-1');
    });

    it('doctor without --reconcile never calls reapOrphanContainers even when orphans exist', async () => {
      h.claudeAvailable = true;
      h.dockerAvailable = true;
      h.orphanContainers = [{ id: 'abc123', name: 'sf-job-1' }];

      const res = await runMain('doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(ops.reapOrphanContainers).not.toHaveBeenCalled();
    });

    it('fails doctor and reports a factory-* sbx VM with no active lane as an orphan', async () => {
      h.claudeAvailable = true;
      h.sbxAvailable = true;
      h.orphanVmNames = ['factory-abc123'];

      const res = await runMain('doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('orphan sbx VM factory-abc123');
      expect(logged()).toContain('has no active lane holding its worktree');
    });

    it('excludes the sbx VM name derived from an alive lease from the orphan set', async () => {
      h.claudeAvailable = true;
      h.sbxAvailable = true;
      const activeName = microVmName(h.repoRoot);
      h.orphanVmNames = [activeName, 'factory-def456'];
      const portsFile = join(h.repoRoot, '.factory', 'state', 'ports.json');
      writeFileSync(
        portsFile,
        JSON.stringify({
          version: 1,
          leases: [
            {
              worktreeId: h.repoRoot,
              branch: 'live',
              port: 4001,
              pid: process.pid,
              acquiredAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );

      const res = await runMain('doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).not.toContain(`orphan sbx VM ${activeName}`);
      expect(logged()).toContain('orphan sbx VM factory-def456');
    });

    it('--reconcile reaps orphan sbx VMs and reports the outcome', async () => {
      h.claudeAvailable = true;
      h.sbxAvailable = true;
      h.orphanVmNames = ['factory-abc123'];
      h.reapedVms = [{ name: 'factory-abc123', removed: true, detail: 'sbx rm --force factory-abc123 ok' }];

      const res = await runMain('doctor', '--reconcile');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(ops.reapOrphanMicroVm).toHaveBeenCalledWith('factory-abc123');
      expect(logged()).toContain('reconcile: removed sbx VM factory-abc123 (sbx rm --force)');
    });

    it('doctor without --reconcile never calls reapOrphanMicroVm even when orphans exist', async () => {
      h.claudeAvailable = true;
      h.sbxAvailable = true;
      h.orphanVmNames = ['factory-abc123'];

      const res = await runMain('doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(ops.reapOrphanMicroVm).not.toHaveBeenCalled();
    });
  });
});
