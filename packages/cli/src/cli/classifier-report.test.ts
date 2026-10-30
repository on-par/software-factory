import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { installCliCommandsHarness, logged, paths, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('classifier report (#1727)', () => {
    const outRec = (prNumber: number, o: Record<string, unknown> = {}) => ({
      issue: String(prNumber),
      prNumber,
      classifiedAt: '2026-09-01T00:00:00.000Z',
      modelClass: 'A',
      floorClass: 'A',
      finalClass: 'A',
      model: 'm',
      promptVersion: 'p1',
      policyVersion: 'v1',
      diffSha: null,
      humanApproved: false,
      humanEdited: false,
      humanAbandoned: false,
      merged: true,
      mergedAt: '2026-08-01T00:00:00.000Z',
      defectWindowClosed: true,
      defectFired: false,
      verdict: 'agree',
      slipped: false,
      ...o,
    });
    const seed = () => {
      const recs = [
        ...Array.from({ length: 60 }, (_, i) => outRec(i + 1)),
        outRec(100, { modelClass: 'B', merged: false, defectWindowClosed: false, verdict: 'pending' }),
      ];
      writeFileSync(paths().classifierOutcomes, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
    };

    it('prints the table, bounds and unknown', async () => {
      seed();
      await runMain('classifier', 'report');
      const out = logged();
      expect(out).toContain('human-gated');
      expect(out).toContain('A: 60 closed, 0 slipped — slip rate ≤ 5%');
      expect(out).toContain('C: 0 closed, 0 slipped — slip rate unknown');
    });

    it('--json prints one JSON object', async () => {
      seed();
      await runMain('classifier', 'report', '--json');
      const lines = logged().trim().split('\n');
      expect(lines).toHaveLength(1);
      const report = JSON.parse(lines[0]);
      expect(report.classes.A.upperBound).toBeCloseTo(0.05);
      expect(report.classes.C.upperBound).toBeNull();
    });

    it('a missing file is not an error', async () => {
      const res = await runMain('classifier', 'report');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('factory kpis');
      expect(logged()).toContain('unknown');
    });
  });
});
