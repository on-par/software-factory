// packages/cli/src/cli/run-queue-hygiene.test.ts — factory run releases expired claims and unqueues a deferred-only queue (#3660)

import { readFileSync, rmSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { h, installShipHarness, logged, paths, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli', () => {
  describe('run queue hygiene', () => {
    it('unqueues a deferred-only queue and logs queue_deferred_only once (#3660)', async () => {
      rmSync(paths().queue, { force: true });
      const labelsByIssue = new Map([
        [3460, ['factory:queued', 'factory:lane:app', 'factory:order:1']],
        [3463, ['factory:queued', 'factory:lane:app', 'factory:order:2']],
      ]);
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [...labelsByIssue].map(([number, labels]) => ({ number, title: `Issue ${number}`, labels })),
      }));
      h.octokit.rest.issues.get = vi.fn(async ({ issue_number }: any) => ({
        data: {
          number: issue_number,
          title: `Issue ${issue_number}`,
          body: `Prerequisite: #${issue_number === 3460 ? 3459 : 3462}`,
        },
      }));
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: any) => ({
        data: (labelsByIssue.get(issue_number) ?? []).map((name) => ({ name })),
      }));
      h.octokit.rest.issues.listLabelsForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
      h.octokit.rest.issues.removeLabel = vi.fn(async () => ({}));
      h.octokit.graphql = vi.fn(async (query: string) => {
        if (!query.includes('QueuePrerequisite')) {
          return { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } };
        }
        return { repository: { issue: { state: 'OPEN' } } };
      });

      const res = await runMain('run');
      expect(res.exited).toBe(false);
      for (const issue_number of [3460, 3463]) {
        expect(h.octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
          expect.objectContaining({ issue_number, name: 'factory:queued' }),
        );
      }
      const lines = readFileSync(paths().events, 'utf-8')
        .split('\n')
        .filter((line) => line.includes('"type":"queue_deferred_only"'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('#3460');
      expect(lines[0]).toContain('#3463');
      expect(logged()).toContain('queue deferred-only');
    });

    it('releases an expired GitHub claim at the start of every run cycle and restores factory:queued (#3660)', async () => {
      rmSync(paths().queue, { force: true });
      const expired = `factory:claim-expires:${Math.floor(Date.now() / 1000) - 7200}`;
      const labels = [
        'factory:in-progress',
        'factory:claimed-by:dead-host-1',
        expired,
        'factory:lane:app',
        'factory:order:1',
      ];
      h.octokit.rest.issues.listForRepo = vi.fn(async ({ labels: wanted }: any) => ({
        data: String(wanted).includes('factory:in-progress') ? [{ number: 3339, title: 'Issue 3339', labels }] : [],
      }));
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: labels.map((name) => ({ name })) }));
      h.octokit.rest.issues.listLabelsForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
      h.octokit.rest.issues.removeLabel = vi.fn(async () => ({}));

      await runMain('run');
      for (const name of ['factory:in-progress', 'factory:claimed-by:dead-host-1', expired]) {
        expect(h.octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
          expect.objectContaining({ issue_number: 3339, name }),
        );
      }
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 3339, labels: ['factory:queued'] }),
      );
      expect(readFileSync(paths().events, 'utf-8')).toContain('"type":"claim_expired_released"');
    });
  });
});
