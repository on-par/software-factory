// packages/cli/src/cli/status-github-claims.test.ts — GitHub-label-queue claims in the Active band (#3344)

import { workKeyFromIssue } from '@on-par/factory-core';
import { writeFileSync } from 'node:fs';

import * as FactoryCore from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';

import { h, installShipHarness, logged, paths, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli status', () => {
  describe('GitHub-label-queue claims in Active (#3344)', () => {
    const activeBand = (): string => {
      const out = logged();
      return out.slice(out.indexOf('== Active =='), out.indexOf('== Host slots =='));
    };
    const stubInProgress = (expiresInSec = 600): void => {
      h.octokit.rest.issues.listForRepo = vi.fn(async ({ labels }: any) =>
        labels === 'factory:in-progress'
          ? {
              data: [
                {
                  number: 3316,
                  labels: [
                    'factory:in-progress',
                    'factory:claimed-by:host-22135',
                    `factory:claim-expires:${Math.floor(Date.now() / 1000) + expiresInSec}`,
                    'factory:lane:bugfix',
                  ],
                },
              ],
            }
          : { data: [] },
      );
    };
    const writeSnapshot = (ageMs: number) =>
      FactoryCore.writePhaseSnapshot(FactoryCore.phaseSnapshotFile(paths().runs, workKeyFromIssue(3316)), {
        issue: 3316,
        phase: 'check',
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date(Date.now() - ageMs).toISOString(),
      });

    it('lists a GitHub-label-queue claim in Active when the local queue file has no entry for it', async () => {
      writeFileSync(paths().queue, '');
      await writeSnapshot(0);
      stubInProgress();

      await runMain('status');
      const band = activeBand();
      expect(band).toContain('bugfix #3316');
      expect(band).toContain('check');
      expect(band).not.toContain('(idle — no active claims)');

      vi.mocked(console.log).mockClear();
      await runMain('status', '--json');
      const json = JSON.parse(logged());
      expect(json.active).toHaveLength(1);
      expect(json.active[0]).toMatchObject({ lane: 'bugfix', issue: 3316, phase: 'check' });
      expect(typeof json.active[0].ageSec).toBe('number');
    });

    it('hides a GitHub-label-queue claim with a stale phase file and counts it as stale', async () => {
      await writeSnapshot(20 * 60_000);
      stubInProgress();

      await runMain('status');
      const band = activeBand();
      expect(band).not.toContain('#3316');
      expect(band).toContain('(idle — no active claims)');
      expect(band).toContain('(1 stale entry hidden — no recent activity)');

      vi.mocked(console.log).mockClear();
      await runMain('status', '--json');
      expect(JSON.parse(logged()).active).toEqual([]);
    });

    it('hides a GitHub-label-queue claim whose claim-expires label is in the past', async () => {
      await writeSnapshot(0);
      stubInProgress(-600);

      await runMain('status');
      const band = activeBand();
      expect(band).not.toContain('#3316');
      expect(band).toContain('(1 stale entry hidden — no recent activity)');
    });

    it('lists an issue in both the local queue and the GitHub in-progress list once', async () => {
      writeFileSync(paths().queue, 'bugfix 3316\n');
      await writeSnapshot(0);
      stubInProgress();

      await runMain('status');
      expect(activeBand().split('#3316')).toHaveLength(2);
    });

    it('makes no GitHub call for Active when there is no token', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.execSyncImpl = () => {
        throw new Error('gh not authenticated');
      };
      const listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listForRepo = listForRepo;

      await runMain('status');
      expect(activeBand()).toContain('(no queue file)');
      expect(listForRepo).not.toHaveBeenCalledWith(expect.objectContaining({ labels: 'factory:in-progress' }));
    });

    it('reports a GitHub claim lookup failure in the Active band without crashing', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw new Error('GitHub API unavailable');
      });

      const res = await runMain('status');
      expect(res.exited).toBe(false);
      expect(activeBand()).toContain('GitHub claim lookup failed');
    });
  });
});
