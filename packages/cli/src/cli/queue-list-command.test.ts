import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errored, h, installCliCommandsHarness, logged, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('queue list', () => {
    const issue = (number: number, labels: string[], title?: string) => ({
      number,
      ...(title === undefined ? {} : { title }),
      labels,
    });

    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
      h.octokit.rest.issues.removeLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
    });

    const twoLanes = (): void => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          issue(2, ['factory:queued', 'factory:lane:other', 'factory:order:5'], 'Two'),
          issue(3, ['factory:queued', 'factory:lane:daw', 'factory:order:9'], 'Three'),
          issue(1, ['factory:queued', 'factory:lane:daw', 'factory:order:2'], 'One'),
        ],
      }));
    };

    it('lists lanes sorted with items in order-label order, read-only', async () => {
      twoLanes();

      const res = await runMain('queue', 'list', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toEqual({
        schemaVersion: 1,
        lanes: [
          {
            lane: 'daw',
            items: [
              { issue: 1, title: 'One', status: 'queued', order: 1, claimedBy: null },
              { issue: 3, title: 'Three', status: 'queued', order: 2, claimedBy: null },
            ],
          },
          { lane: 'other', items: [{ issue: 2, title: 'Two', status: 'queued', order: 1, claimedBy: null }] },
        ],
        orderConflicts: [],
      });
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
    });

    it('--lane returns only that lane', async () => {
      twoLanes();

      const res = await runMain('queue', 'list', '--json', '--lane', 'other');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged()).lanes.map((l: { lane: string }) => l.lane)).toEqual(['other']);
    });

    it('reports parked status', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [issue(4, ['factory:queued', 'factory:lane:daw', 'factory:order:1', 'factory:parked'])],
      }));

      await runMain('queue', 'list', '--json');

      expect(JSON.parse(logged()).lanes[0].items[0]).toMatchObject({ issue: 4, status: 'parked' });
    });

    it('reports in-progress status and claimant', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          issue(5, [
            'factory:queued',
            'factory:lane:daw',
            'factory:order:1',
            'factory:in-progress',
            'factory:claimed-by:host-1',
          ]),
        ],
      }));

      await runMain('queue', 'list', '--json');

      expect(JSON.parse(logged()).lanes[0].items[0]).toMatchObject({
        issue: 5,
        status: 'in-progress',
        claimedBy: 'host-1',
      });
    });

    it('prints empty lanes when nothing is queued', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'list', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toEqual({ schemaVersion: 1, lanes: [], orderConflicts: [] });
    });

    it('exits 1 with stderr only on a GitHub read failure', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw Object.assign(new Error('Bad credentials'), { status: 401 });
      });

      const res = await runMain('queue', 'list', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toBe('');
      expect(errored()).toContain('queue list failed');
      expect(errored()).toContain('Bad credentials');
    });

    it('exits 2 without --json and makes no GitHub call', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'list');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('requires --json');
      expect(logged()).toBe('');
      expect(h.octokit.rest.issues.listForRepo).not.toHaveBeenCalled();
    });
  });
});
