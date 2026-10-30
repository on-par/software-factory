import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errored, h, installCliCommandsHarness, logged, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('queue clear', () => {
    const removeLabel = vi.fn();
    const addLabels = vi.fn();

    beforeEach(() => {
      removeLabel.mockClear();
      addLabels.mockClear();
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.removeLabel = removeLabel;
      h.octokit.rest.issues.addLabels = addLabels;
      const labelsFor = (n: number): string[] =>
        n === 10
          ? ['factory:queued', 'factory:lane:daw', 'factory:order:1']
          : n === 11
            ? ['factory:queued', 'factory:lane:daw', 'factory:in-progress', 'factory:claimed-by:host-1']
            : ['factory:queued', 'factory:lane:daw'];
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: { issue_number: number }) => ({
        data: labelsFor(issue_number).map((name) => ({ name })),
      }));
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          { number: 10, title: 'Queued issue', labels: labelsFor(10) },
          { number: 11, labels: labelsFor(11) },
          { number: 12, labels: labelsFor(12) },
        ],
      }));
    });

    it('--dry-run lists every queued issue with its lane and exits 0 without writing', async () => {
      const res = await runMain('queue', 'clear', '--dry-run');

      expect(res).toEqual({ exited: false, code: undefined });
      for (const n of [10, 11, 12]) expect(logged()).toContain(`#${n} [lane daw]`);
      expect(logged()).toContain('would-skip');
      expect(logged()).toContain('3 queued issue(s): 2 would-clear, 1 would-skip');
      expect(removeLabel).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('exits 2 without --dry-run or --yes, after printing the preview', async () => {
      const res = await runMain('queue', 'clear');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(logged()).toContain('#10 [lane daw] would-clear');
      expect(errored()).toContain('--yes');
      expect(removeLabel).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('--yes removes queue labels, keeps lanes, and skips claimed issues', async () => {
      const res = await runMain('queue', 'clear', '--yes');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('#10 [lane daw] cleared');
      expect(logged()).toContain('#11 [lane daw] skipped — claimed');
      expect(logged()).toContain('#12 [lane daw] cleared');
      expect(logged()).toContain('3 queued issue(s): 2 cleared, 1 skipped');
      const removed = removeLabel.mock.calls.map(([arg]) => [arg.issue_number, arg.name]);
      expect(removed).toContainEqual([10, 'factory:queued']);
      expect(removed).toContainEqual([10, 'factory:order:1']);
      expect(removed).toContainEqual([12, 'factory:queued']);
      expect(removed.some(([n]) => n === 11)).toBe(false);
      expect(removed.some(([, name]) => String(name).startsWith('factory:lane:'))).toBe(false);
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('--yes on an empty queue reports it and does not remove labels', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'clear', '--yes');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('already empty');
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('reports an already-empty queue and exits 0', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'clear', '--dry-run');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('already empty');
    });

    describe('--lane', () => {
      const issueLabels: Record<number, string[]> = {
        10: ['factory:queued', 'factory:lane:ops', 'factory:order:1'],
        11: ['factory:queued', 'factory:lane:review', 'factory:order:2'],
        12: ['factory:queued', 'factory:lane:ops'],
      };
      let listForRepo: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: { issue_number: number }) => ({
          data: (issueLabels[issue_number] ?? []).map((name) => ({ name })),
        }));
        listForRepo = vi.fn(async ({ labels }: { labels: string }) => {
          const wanted = labels.split(',');
          return {
            data: Object.entries(issueLabels)
              .filter(([, ls]) => wanted.every((w) => ls.includes(w)))
              .map(([n, ls]) => ({ number: Number(n), labels: ls })),
          };
        });
        h.octokit.rest.issues.listForRepo = listForRepo;
      });

      it('--dry-run lists only that lane and writes nothing', async () => {
        const res = await runMain('queue', 'clear', '--lane', 'ops', '--dry-run');

        expect(res).toEqual({ exited: false, code: undefined });
        expect(listForRepo).toHaveBeenCalledWith(
          expect.objectContaining({ labels: 'factory:queued,factory:lane:ops' }),
        );
        expect(logged()).toContain('#10 [lane ops]');
        expect(logged()).toContain('#12 [lane ops]');
        expect(logged()).not.toContain('#11');
        expect(removeLabel).not.toHaveBeenCalled();
        expect(addLabels).not.toHaveBeenCalled();
      });

      it('--yes clears only that lane and never touches other lanes or lane labels', async () => {
        const res = await runMain('queue', 'clear', '--lane', 'ops', '--yes');

        expect(res).toEqual({ exited: false, code: undefined });
        const removed = removeLabel.mock.calls.map(([arg]) => [arg.issue_number, arg.name]);
        expect(removed).toContainEqual([10, 'factory:queued']);
        expect(removed).toContainEqual([12, 'factory:queued']);
        expect(removed.some(([n]) => n === 11)).toBe(false);
        expect(removed.some(([, name]) => String(name).startsWith('factory:lane:'))).toBe(false);
      });

      it('reports an empty lane and exits 0 without writing', async () => {
        const res = await runMain('queue', 'clear', '--lane', 'docs', '--yes');

        expect(res).toEqual({ exited: false, code: undefined });
        expect(logged()).toContain('already empty for lane docs');
        expect(removeLabel).not.toHaveBeenCalled();
      });
    });
  });
});
