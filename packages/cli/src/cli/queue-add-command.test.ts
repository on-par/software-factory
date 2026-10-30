import { existsSync, readFileSync, rmSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errored, h, installCliCommandsHarness, logged, paths, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('queue add', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: [] }));
    });

    it.each(['', '   '])('exits 2 for an empty or whitespace lane before any GitHub call', async (lane) => {
      const res = await runMain('queue', 'add', lane, '1');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('lane');
      for (const fn of ['createLabel', 'addLabels', 'listForRepo'] as const)
        expect(h.octokit.rest.issues[fn]).not.toHaveBeenCalled();
    });

    it('prints the applied lane slug in the success line', async () => {
      await runMain('queue', 'add', 'a b', '1');
      expect(logged()).toContain('lane a-b');
      expect(logged()).not.toContain('lane a b');
    });

    it('queues explicit issues into a lane, applying queued/lane/order labels in order', async () => {
      const res = await runMain('queue', 'add', 'daw', '10', '11');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('#10 queued');
      expect(logged()).toContain('#11 queued');
      for (const [i, issue_number] of [10, 11].entries()) {
        expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(i + 1, {
          owner: 'on-par',
          repo: 'software-factory',
          issue_number,
          labels: ['factory:queued', 'factory:lane:daw', `factory:order:${i + 1}`],
        });
      }
    });

    it('creates missing factory labels idempotently before applying them', async () => {
      await runMain('queue', 'add', 'daw', '10');
      for (const name of ['factory:queued', 'factory:lane:daw', 'factory:order:1'])
        expect(h.octokit.rest.issues.createLabel).toHaveBeenCalledWith(expect.objectContaining({ name }));
    });

    it('exits nonzero and reports a per-issue failure without dropping the successful issue', async () => {
      h.octokit.rest.issues.addLabels = vi.fn(async ({ issue_number }: any) => {
        if (issue_number === 10) throw new Error('label API down');
        return {};
      });

      const res = await runMain('queue', 'add', 'daw', '10', '11');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('#10 failed');
      expect(logged()).toContain('#11 queued');
    });

    it('exits 2 for an invalid issue argument before any GitHub call', async () => {
      const res = await runMain('queue', 'add', 'daw', 'notanumber');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('--json prints exactly one JSON object with orders and created labels', async () => {
      const res = await runMain('queue', 'add', 'ops', '1', '2', '--json');

      expect(res.exited).toBe(false);
      expect(logged().trim().split('\n')).toHaveLength(1);
      const json = JSON.parse(logged());
      expect(json.ok).toBe(true);
      expect(json.issues.map((i: any) => [i.number, i.order])).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect(json.labelsCreated).toEqual(
        expect.arrayContaining(['factory:queued', 'factory:lane:ops', 'factory:order:1']),
      );
    });

    it('--json reports an already-queued issue with its order and no writes', async () => {
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: any) => ({
        data: issue_number === 1 ? [{ name: 'factory:order:5' }] : [],
      }));

      await runMain('queue', 'add', 'ops', '1', '2', '--json');

      const json = JSON.parse(logged());
      expect(json.issues[0]).toEqual({ number: 1, outcome: 'already-queued', order: 5, labelsAdded: [] });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 2 }));
    });

    it('--json reports no created labels when they already exist (422)', async () => {
      h.octokit.rest.issues.createLabel = vi.fn(async () => {
        throw { status: 422 };
      });

      await runMain('queue', 'add', 'ops', '1', '--json');

      expect(JSON.parse(logged()).labelsCreated).toEqual([]);
    });

    it('--json prints ok:false and exits 1 on a partial failure', async () => {
      h.octokit.rest.issues.addLabels = vi.fn(async ({ issue_number }: any) => {
        if (issue_number === 10) throw new Error('label API down');
        return {};
      });

      const res = await runMain('queue', 'add', 'daw', '10', '11', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged().trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(logged()).ok).toBe(false);
      expect(errored()).toContain('failed to queue');
    });

    it('--json exits 1 with empty stdout when the lane listing throws', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw new Error('api down');
      });

      const res = await runMain('queue', 'add', 'ops', '1', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toBe('');
      expect(errored()).toContain('queue add failed');
    });

    it('text mode prints only the per-issue lines (no event echo)', async () => {
      await runMain('queue', 'add', 'daw', '10', '11');

      expect(logged().split('\n').filter(Boolean)).toHaveLength(2);
      expect(logged()).not.toContain('queue_added');
    });

    it('records a queue_added event only when something was queued', async () => {
      await runMain('queue', 'add', 'ops', '1', '--json');
      expect(readFileSync(paths().events, 'utf-8')).toContain('"type":"queue_added"');

      rmSync(paths().events, { force: true });
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: [{ name: 'factory:order:1' }] }));
      await runMain('queue', 'add', 'ops', '1', '--json');
      expect(existsSync(paths().events)).toBe(false);
    });
  });
});
