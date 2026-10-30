import { describe, expect, it } from 'vitest';

import {
  errored,
  h,
  installCliCommandsHarness,
  logged,
  runMain,
  runMainWith,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('usage', () => {
    it('prints the usage report from resolved knobs', async () => {
      await runMain('usage');
      expect(logged()).toContain('USAGE REPORT');
    });

    it('exits 2 on an invalid usage cap', async () => {
      process.env.FACTORY_USAGE_CAP = '-5';
      const res = await runMain('usage');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('FACTORY_USAGE_CAP');
    });

    it('--json prints the subscription reading as one JSON object', async () => {
      h.subscriptionUsage = { fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' };
      const res = await runMain('usage', '--json');
      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toMatchObject({
        schemaVersion: 1,
        source: 'subscription',
        utilizationPct: 42,
        resetsAt: '2026-07-15T18:00:00Z',
      });
      expect(logged()).not.toContain('USAGE REPORT');
    });

    it('--json falls back to the heuristic when no subscription reading', async () => {
      h.subscriptionUsage = null;
      await runMain('usage', '--json');
      const json = JSON.parse(logged());
      expect(json.source).toBe('heuristic');
      expect(json.estimateUsd).toBe(h.trailingSpend);
    });

    it('--json is unavailable with nulls when the estimator throws', async () => {
      h.subscriptionUsage = null;
      const res = await runMainWith(
        {
          estimateTrailingSpend: () => {
            throw new Error('boom');
          },
        } as any,
        'usage',
        '--json',
      );
      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toMatchObject({
        source: 'unavailable',
        utilizationPct: null,
        resetsAt: null,
        estimateUsd: null,
      });
    });

    it('--json exits 2 on an invalid usage cap with nothing on stdout', async () => {
      process.env.FACTORY_USAGE_CAP = '-5';
      const res = await runMain('usage', '--json');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('FACTORY_USAGE_CAP');
      expect(logged()).toBe('');
    });
  });
});
