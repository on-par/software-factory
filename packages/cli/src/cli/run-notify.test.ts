// packages/cli/src/cli/run-notify.test.ts — factory run --notify tests (#3512)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installShipHarness, paths, runMainWith, trackEnv } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli', () => {
  describe('run', () => {
    describe('--notify', () => {
      const notifyFile = () => join(paths().state, 'notify.ndjson');
      const lines = () =>
        readFileSync(notifyFile(), 'utf-8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l));
      const drains = () => lines().filter((l) => l.kind === 'drain');

      it('fires the --notify command exactly once on run-done with a drained summary', async () => {
        writeFileSync(paths().queue, '# header\napp 1\n');
        const res = await runMain('run', '--local-queue', '--notify', `cat >> ${notifyFile()}`);
        expect(res.exited).toBe(false);
        const got = drains();
        expect(got).toHaveLength(1);
        expect(got[0].kind).toBe('drain');
        expect(got[0].message).toContain('nothing left');
        expect(readFileSync(paths().events, 'utf-8')).toContain('run-done');
      });

      it('uses FACTORY_NOTIFY_CMD when --notify is omitted', async () => {
        trackEnv('FACTORY_NOTIFY_CMD');
        process.env.FACTORY_NOTIFY_CMD = `cat >> ${notifyFile()}`;
        writeFileSync(paths().queue, '# header\napp 1\n');
        const res = await runMain('run', '--local-queue');
        expect(res.exited).toBe(false);
        expect(drains()).toHaveLength(1);
      });

      it('completes the run and logs a warn when the --notify command fails', async () => {
        writeFileSync(paths().queue, '# header\napp 1\n');
        const res = await runMain('run', '--local-queue', '--notify', 'exit 7');
        expect(res.exited).toBe(false);
        const events = readFileSync(paths().events, 'utf-8');
        expect(events).toContain('run-done');
        expect(events).toMatch(/"type":"warn"[^\n]*notify command 'exit 7' failed/);
      });
    });
  });
});
