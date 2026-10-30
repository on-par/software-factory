import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as FactoryCore from '@on-par/factory-core';
import { beforeEach, describe, expect, it } from 'vitest';

import { errored, h, installCliCommandsHarness, logged, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('runs', () => {
    const runsDir = (): string => FactoryCore.getFactoryPaths(h.repoRoot).runs;
    const writeRun = (n: number, updatedAt: string): void => {
      mkdirSync(runsDir(), { recursive: true });
      writeFileSync(
        join(runsDir(), `issue-${n}.json`),
        JSON.stringify({ issue: n, lane: 'daw', startedAt: updatedAt, updatedAt }),
      );
    };

    beforeEach(() => {
      h.execImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
    });

    it('prints runs newest first', async () => {
      writeRun(1, '2026-01-01T00:00:00Z');
      writeRun(2, '2026-01-03T00:00:00Z');
      writeRun(3, '2026-01-02T00:00:00Z');

      const res = await runMain('runs', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      const out = JSON.parse(logged()) as { schemaVersion: number; runs: Array<{ issue: number }> };
      expect(out.schemaVersion).toBe(1);
      expect(out.runs.map((r) => r.issue)).toEqual([2, 3, 1]);
    });

    it('honors --limit', async () => {
      writeRun(1, '2026-01-01T00:00:00Z');
      writeRun(2, '2026-01-03T00:00:00Z');

      await runMain('runs', '--json', '--limit', '1');

      expect((JSON.parse(logged()) as { runs: unknown[] }).runs).toHaveLength(1);
    });

    it('prints an empty list when there is no runs dir', async () => {
      const res = await runMain('runs', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toBe('{"schemaVersion":1,"runs":[]}');
    });

    it('skips a malformed file with a stderr note and exit 0', async () => {
      writeRun(1, '2026-01-01T00:00:00Z');
      writeFileSync(join(runsDir(), 'issue-9.json'), '{not json');

      const res = await runMain('runs', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(errored()).toContain('skipped malformed issue-9.json');
      expect((JSON.parse(logged()) as { runs: unknown[] }).runs).toHaveLength(1);
    });

    it('exits 2 without --json', async () => {
      const res = await runMain('runs');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('requires --json');
      expect(logged()).toBe('');
    });

    it('exits 2 on an invalid --limit', async () => {
      const res = await runMain('runs', '--json', '--limit', '0');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid --limit');
      expect(logged()).toBe('');
    });

    it('--diffstat exits 1 when the issue has no run', async () => {
      const res = await runMain('runs', '--json', '--diffstat', '99');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no run for issue #99');
      expect(logged()).toBe('');
    });

    it('--diffstat exits 2 on an invalid issue', async () => {
      const res = await runMain('runs', '--json', '--diffstat', 'abc');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid --diffstat');
      expect(logged()).toBe('');
    });

    it('--diffstat exits 2 without --json', async () => {
      const res = await runMain('runs', '--diffstat', '5');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('requires --json');
    });

    it('--diffstat exits 2 when combined with --limit', async () => {
      const res = await runMain('runs', '--json', '--diffstat', '5', '--limit', '2');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('cannot be combined');
    });

    it('--diffstat prints files null with reason no-branch for an empty branch', async () => {
      mkdirSync(runsDir(), { recursive: true });
      writeFileSync(
        join(runsDir(), 'issue-5.json'),
        JSON.stringify({ issue: 5, lane: 'daw', branch: '', updatedAt: '2026-01-01T00:00:00Z' }),
      );

      const res = await runMain('runs', '--json', '--diffstat', '5');

      expect(res).toEqual({ exited: false, code: undefined });
      const out = JSON.parse(logged()) as { files: unknown; reason: string; base: unknown };
      expect(out.files).toBeNull();
      expect(out.reason).toBe('no-branch');
      expect(typeof out.base).toBe('string');
    });
  });
});
