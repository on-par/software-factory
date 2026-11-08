import { afterEach, describe, expect, it } from 'vitest';

import { addCommandOutputSink, withCommandOutputCapture, type CommandOutputRecord } from '../command-output/index.js';
import { createDefaultExecFn } from './exec.js';

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

describe('harness exec capture exclusion', () => {
  it('harness exec output inside an active capture scope produces no records', async () => {
    const records: CommandOutputRecord[] = [];
    disposers.push(addCommandOutputSink((r) => records.push(r)));
    const exec = createDefaultExecFn();
    const cmd = `"${process.execPath}" -e "console.log('model says hi'); console.error('model err')"`;
    await withCommandOutputCapture({ runId: 'r', issue: '1', laneId: 'l', phase: 'check' }, async () => {
      const a = await exec(cmd, {});
      const b = await exec(cmd, { onPgid: () => {} });
      expect(a.stdout).toContain('model says hi');
      expect(b.stdout).toContain('model says hi');
    });
    expect(records).toEqual([]);
  });
});
