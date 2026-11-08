import { afterEach, describe, expect, it } from 'vitest';

import {
  type CommandOutputRecord,
  registerCommandOutputSink,
  withCommandOutputScope,
} from '../command-output/capture.js';
import { defaultStartApp } from './app-smoke.js';

const unregs: Array<() => void> = [];
afterEach(() => {
  while (unregs.pop()?.());
});

describe('defaultStartApp capture (#3994)', () => {
  it('defaultStartApp emits app boot output records inside a scope', async () => {
    const records: CommandOutputRecord[] = [];
    unregs.push(registerCommandOutputSink((r) => records.push(r)));
    const script = `console.log('boot out'); console.error('boot err');`;
    const app = await withCommandOutputScope({ runId: 'r', issue: 'gh:2', lane: 'l', phase: 'check' }, async () => {
      const started = defaultStartApp([process.execPath, '-e', script], { cwd: process.cwd(), env: process.env });
      await started.exited;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return started;
    });
    expect(app.output()).toContain('boot out');
    expect(records.map((r) => [r.stream, r.text]).sort()).toEqual([
      ['stderr', 'boot err\n'],
      ['stdout', 'boot out\n'],
    ]);
    expect(records[0].phase).toBe('check');
  });
});
