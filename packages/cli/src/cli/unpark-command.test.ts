import { existsSync, readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errored, h, installCliCommandsHarness, logged, paths, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('unpark', () => {
    let labels: string[];
    beforeEach(() => {
      labels = ['factory:parked', 'factory:lane:ops'];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async ({ labels: add }: any) => {
        labels.push(...add.filter((l: string) => !labels.includes(l)));
        return {};
      });
      h.octokit.rest.issues.removeLabel = vi.fn(async ({ name }: any) => {
        labels = labels.filter((l) => l !== name);
        return {};
      });
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [{ number: 12, labels: [labels[1]] }] }));
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: labels.map((name) => ({ name })) }));
    });

    it('--json re-queues a parked issue and prints one object', async () => {
      const res = await runMain('unpark', '12', '--json');

      expect(res.exited).toBe(false);
      expect(logged().trim().split('\n')).toHaveLength(1);
      const json = JSON.parse(logged());
      expect(json).toMatchObject({ schemaVersion: 1, action: 'unpark', issue: 12, lane: 'ops', order: 1 });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: expect.arrayContaining(['factory:order:1']) }),
      );
      expect(h.octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'factory:parked' }),
      );
    });

    it('text mode prints the position line', async () => {
      await runMain('unpark', '12');
      expect(logged()).toContain('#12 unparked → lane ops, position 1');
    });

    it('fails with [not-parked], empty stdout and no event when not parked', async () => {
      labels = ['factory:lane:ops'];
      const res = await runMain('unpark', '12', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toBe('');
      expect(errored()).toContain('[not-parked]');
      expect(existsSync(paths().events)).toBe(false);
    });

    it('fails with [lane-required] when no lane label and no --lane', async () => {
      labels = ['factory:parked'];
      const res = await runMain('unpark', '12');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('[lane-required]');
    });

    it('records an issue_unparked event on success', async () => {
      await runMain('unpark', '12', '--json');
      expect(readFileSync(paths().events, 'utf-8')).toContain('"type":"issue_unparked"');
    });

    it('exits 2 for an invalid issue argument', async () => {
      const res = await runMain('unpark', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });
  });
});
