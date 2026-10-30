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
  describe('cost', () => {
    it('reports no data when there are no costs', async () => {
      h.costs = [];
      await runMain('cost');
      expect(logged()).toContain('no cost data yet');
    });

    it('--json prints one JSON line with unpriced rows as null', async () => {
      h.costs = [
        { ts: 't', issue: '296', task: 'plan', model: 'a', inputTokens: 1, outputTokens: 2, cost: 1 },
        { ts: 't', issue: '297', task: 'build', model: 'b', cost: null, unpriced: true },
      ];
      const res = await runMain('cost', '--json');
      expect(res.exited).toBe(false);
      const out = logged().trim();
      expect(out.split('\n')).toHaveLength(1);
      const json = JSON.parse(out);
      expect(json.schemaVersion).toBe(1);
      expect(json.total).toMatchObject({ cost: 1, unpricedCount: 1, tokens: { input: 1, output: 2, rawInput: 0 } });
      expect(json.rows[1].cost).toBeNull();
    });

    it('--json --issue keeps only that issue', async () => {
      h.costs = [
        { issue: '296', task: 'plan', model: 'a', cost: 1 },
        { issue: '297', task: 'plan', model: 'b', cost: 2 },
      ];
      await runMain('cost', '--json', '--issue', '296');
      const json = JSON.parse(logged());
      expect(json.rows).toHaveLength(1);
      expect(json.rows[0].issue).toBe('296');
      expect(json.total).toMatchObject({ cost: 1, unpricedCount: 0, tokens: { input: 0, output: 0, rawInput: 0 } });
    });

    it('--json with no costs prints empty JSON, not the text message', async () => {
      h.costs = [];
      await runMain('cost', '--json');
      expect(JSON.parse(logged())).toMatchObject({
        schemaVersion: 1,
        rows: [],
        perModel: [],
        total: { cost: 0, unpricedCount: 0, tokens: { input: 0, output: 0, rawInput: 0 } },
      });
    });

    it('--json exits 1 when reading costs throws', async () => {
      const res = await runMainWith(
        {
          readCosts: () => {
            throw new Error('boom');
          },
        },
        'cost',
        '--json',
      );
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('factory: cost failed');
      expect(logged()).toBe('');
    });

    it('uses a readCosts override passed through main deps', async () => {
      h.costs = [{ model: 'shared', cost: 1 }];
      await runMainWith(
        { readCosts: () => [{ issue: '9', task: 'plan', model: 'override-model', cost: 1 }] as any },
        'cost',
      );
      const out = logged();
      expect(out).toContain('override-model');
      expect(out).not.toContain('shared');
    });

    it('uses a formatUsageReport override passed through main deps', async () => {
      await runMainWith({ formatUsageReport: () => 'OVERRIDE USAGE' } as any, 'usage');
      expect(logged()).toContain('OVERRIDE USAGE');
    });

    it('aggregates costs by model with a grand total', async () => {
      h.costs = [
        { model: 'a', cost: 1 },
        { model: 'a', cost: 0.5 },
        { model: 'b', cost: 2 },
      ];
      await runMain('cost');
      const out = logged();
      expect(out).toContain('Cost Summary');
      expect(out).toContain('a: 2 tasks, $1.5000');
      expect(out).toContain('b: 1 tasks, $2.0000');
      expect(out).toContain('Total: $3.5000');
    });

    it('prints unknown for an all-unpriced summary', async () => {
      h.costs = [{ model: 'x', cost: null, unpriced: true }];
      await runMain('cost');
      const out = logged();
      expect(out).toContain('Total: unknown (1 unpriced)');
      expect(out).not.toContain('$0.0000');
    });

    it('excludes unpriced rows from a mixed total and counts them', async () => {
      h.costs = [
        { model: 'a', cost: 1 },
        { model: 'x', cost: null, unpriced: true },
      ];
      await runMain('cost');
      expect(logged()).toContain('Total: $1.0000 (1 unpriced)');
    });

    it('prints unknown for an unpriced row under --issue', async () => {
      h.costs = [{ issue: '5', task: 'plan', model: 'x', cost: null, unpriced: true }];
      await runMain('cost', '--issue', '5');
      const out = logged();
      expect(out).toContain('plan x unknown');
      expect(out).toContain('Total: unknown (1 unpriced)');
    });

    it('shows a per-entry breakdown filtered to one issue via --issue', async () => {
      h.costs = [
        { issue: '296', task: 'build_codex', model: 'qwen', cost: 0, failoverReason: 'rate_limit' },
        { issue: '296', task: 'plan', model: 'opus', cost: 0.12 },
        { issue: '7', task: 'plan', model: 'opus', cost: 0.05 },
      ];
      await runMain('cost', '--issue', '296');
      const out = logged();
      expect(out).toContain('build_codex');
      expect(out).toContain('qwen');
      expect(out).toContain('[failover: rate_limit]');
      expect(out).not.toContain('0.05');
    });

    it('reports no cost data for an issue with no entries', async () => {
      h.costs = [{ issue: '7', task: 'plan', model: 'opus', cost: 0.05 }];
      await runMain('cost', '--issue', '296');
      expect(logged()).toContain('no cost data for issue 296');
    });

    it('appends a failover count to the summary line only when failovers are present', async () => {
      h.costs = [
        { model: 'a', cost: 1 },
        { model: 'a', cost: 0.5, failoverReason: 'rate_limit' },
        { model: 'b', cost: 2 },
      ];
      await runMain('cost');
      const out = logged();
      expect(out).toContain('a: 2 tasks, $1.5000 (1 failover)');
      expect(out).toContain('b: 1 tasks, $2.0000');
      expect(out).not.toContain('b: 1 tasks, $2.0000 (');
    });
  });
});
