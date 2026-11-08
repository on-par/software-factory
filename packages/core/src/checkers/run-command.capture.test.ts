import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addCommandOutputSink, withCommandOutputCapture, type CommandOutputRecord } from '../command-output/index.js';
import { runVerificationCommand } from './run-command.js';

const corr = { runId: 'r', issue: '7', laneId: 'l', phase: 'check' };
const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

describe('runVerificationCommand capture', () => {
  it("delivers a checker command's first line to the sink before the command exits", async () => {
    let first!: (r: CommandOutputRecord) => void;
    const firstSeen = new Promise<CommandOutputRecord>((res) => (first = res));
    disposers.push(addCommandOutputSink((r) => first(r)));
    const gate = join(mkdtempSync(join(tmpdir(), 'cap-gate-')), 'go');
    const script = `console.log('first line'); const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) { clearInterval(t); process.exit(0); } }, 20);`;
    const run = withCommandOutputCapture(corr, () => runVerificationCommand([process.execPath, '-e', script], {}));
    const rec = await firstSeen;
    expect(rec.text).toBe('first line');
    expect(rec.issue).toBe('7');
    // the command has not exited yet: the gate file is what lets it finish
    writeFileSync(gate, '');
    const result = await run;
    expect(result.exitCode).toBe(0);
  });

  it('tags stdout and stderr records with their stream', async () => {
    const records: CommandOutputRecord[] = [];
    disposers.push(addCommandOutputSink((r) => records.push(r)));
    const script = "console.log('to-out'); console.error('to-err');";
    await withCommandOutputCapture(corr, () => runVerificationCommand([process.execPath, '-e', script], {}));
    expect(records.map((r) => [r.stream, r.text]).sort()).toEqual([
      ['stderr', 'to-err'],
      ['stdout', 'to-out'],
    ]);
  });

  it('passes no onOutput when no capture is active', async () => {
    const records: CommandOutputRecord[] = [];
    disposers.push(addCommandOutputSink((r) => records.push(r)));
    let called = false;
    const result = await runVerificationCommand([process.execPath, '-e', "console.log('x')"], {
      onOutput: () => {
        called = true;
      },
    });
    expect(result.stdout.trim()).toBe('x');
    expect(records).toEqual([]);
    expect(called).toBe(true);
  });
});
