import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type CommandOutputRecord,
  registerCommandOutputSink,
  withCommandOutputScope,
} from '../command-output/capture.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { runVerificationCommand } from './run-command.js';

const corr = { runId: 'r1', issue: 'gh:1', lane: 'l1', phase: 'check' };
const tmp = createTempDirs();
const unregs: Array<() => void> = [];

afterEach(async () => {
  while (unregs.length) unregs.pop()?.();
  await tmp.cleanup();
});

function capture(onRecord?: (r: CommandOutputRecord) => void): CommandOutputRecord[] {
  const records: CommandOutputRecord[] = [];
  unregs.push(
    registerCommandOutputSink((r) => {
      records.push(r);
      onRecord?.(r);
    }),
  );
  return records;
}

const inScope = <T>(fn: () => Promise<T>) => withCommandOutputScope(corr, fn);

describe('runVerificationCommand capture (#3994)', () => {
  it('delivers the first stdout line before the command exits', async () => {
    const dir = await tmp.make('run-capture-');
    const gate = join(dir, 'gate');
    const records = capture(() => writeFileSync(gate, 'go'));
    const script = `console.log('first'); const fs = require('fs'); const t = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(t); console.log('second'); } }, 20);`;
    const r = await inScope(() => runVerificationCommand([process.execPath, '-e', script, gate], {}));
    expect(r.ok).toBe(true);
    expect(existsSync(gate)).toBe(true);
    expect(records.map((x) => x.text)).toEqual(['first\n', 'second\n']);
  });

  it('tags stderr lines with stream stderr and stdout lines with stream stdout', async () => {
    const records = capture();
    await inScope(() => runVerificationCommand([process.execPath, '-e', `console.log('o'); console.error('e');`], {}));
    expect(records.map((x) => [x.stream, x.text]).sort()).toEqual([
      ['stderr', 'e\n'],
      ['stdout', 'o\n'],
    ]);
    expect(records.every((x) => x.runId === 'r1' && x.commandId === 'cmd-0')).toBe(true);
  });

  it('redacts a secret the command prints across two writes', async () => {
    const records = capture();
    const prefix = ['gh', 'p', '_'].join('');
    const body = 'a1B2'.repeat(9);
    const script = `process.stdout.write(process.argv[1] + process.argv[2].slice(0, 10)); setTimeout(() => process.stdout.write(process.argv[2].slice(10) + '\\n'), 100);`;
    await inScope(() => runVerificationCommand([process.execPath, '-e', script, prefix, body], {}));
    const text = records.map((x) => x.text).join('');
    expect(text).not.toContain(body.slice(0, 10));
    expect(text).toContain('[redacted]');
  });

  it('returns the same CommandResult with capture on as without', async () => {
    const argv = [process.execPath, '-e', `console.log('a'); console.error('b');`];
    const off = await inScope(() => runVerificationCommand(argv, {}));
    capture();
    const on = await inScope(() => runVerificationCommand(argv, {}));
    expect(on).toEqual(off);
  });
});
