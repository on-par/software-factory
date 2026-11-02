import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { h, installCliCommandsHarness, logged, paths, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('queue reconcile', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          {
            number: 10,
            title: 'Queued issue',
            labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'],
          },
        ],
      }));
    });

    it('exits 0 and reports no conflicts when no admission.json is present', async () => {
      const res = await runMain('queue', 'reconcile');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('1 queued issue(s), 0 conflict(s)');
      expect(logged()).toContain('no Factory App admission conflicts');
    });

    it('exits 1 and reports the conflict when admission state refuses the issue', async () => {
      writeFileSync(
        join(paths().state, 'admission.json'),
        JSON.stringify({
          version: 1,
          records: [{ issue: 10, state: 'executing', deliveryId: 'del-1' }],
        }),
      );

      const res = await runMain('queue', 'reconcile');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('1 queued issue(s), 1 conflict(s)');
      expect(logged()).toContain('[daw] #10:');
      expect(logged()).toContain('repair:');
    });

    it('--lane filters the report to a single lane', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          { number: 10, labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'] },
          { number: 20, labels: ['factory:queued', 'factory:lane:other', 'factory:order:1'] },
        ],
      }));
      writeFileSync(
        join(paths().state, 'admission.json'),
        JSON.stringify({
          version: 1,
          records: [
            { issue: 10, state: 'executing' },
            { issue: 20, state: 'executing' },
          ],
        }),
      );

      const res = await runMain('queue', 'reconcile', '--lane', 'other');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('1 queued issue(s), 1 conflict(s)');
      expect(logged()).toContain('[other] #20:');
      expect(logged()).not.toContain('[daw]');
    });
  });
});
