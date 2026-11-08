import { afterEach, describe, expect, it } from 'vitest';

import { addCommandOutputSink, withCommandOutputCapture, type CommandOutputRecord } from '../command-output/index.js';
import { defaultStartApp } from './app-smoke.js';

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

describe('defaultStartApp capture', () => {
  it('defaultStartApp streams app boot output into an active capture', async () => {
    const records: CommandOutputRecord[] = [];
    disposers.push(addCommandOutputSink((r) => records.push(r)));
    const script = "console.log('booting'); console.error('warn');";
    await withCommandOutputCapture({ runId: null, issue: '9', laneId: null, phase: 'check' }, async () => {
      const app = defaultStartApp([process.execPath, '-e', script], {
        cwd: process.cwd(),
        env: process.env,
        onPgid: () => {},
      });
      await app.exited;
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(records.map((r) => [r.stream, r.text]).sort()).toEqual([
      ['stderr', 'warn'],
      ['stdout', 'booting'],
    ]);
    expect(records[0].issue).toBe('9');
  });
});
