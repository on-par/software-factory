import { afterEach, describe, expect, it } from 'vitest';

import {
  addCommandOutputSink,
  openCommandCapture,
  withCommandOutputCapture,
  type CommandOutputRecord,
} from './capture.js';

const enc = (s: string) => new TextEncoder().encode(s);
const corr = { runId: 'run-1', issue: '42', laneId: 'lane-a', phase: 'check' };
const disposers: Array<() => void> = [];

function collect(): CommandOutputRecord[] {
  const records: CommandOutputRecord[] = [];
  disposers.push(addCommandOutputSink((r) => records.push(r)));
  return records;
}

afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

describe('command output capture', () => {
  it('returns undefined outside a capture scope', () => {
    collect();
    expect(openCommandCapture()).toBeUndefined();
  });

  it('returns undefined with no sink registered', () => {
    expect(withCommandOutputCapture(corr, () => openCommandCapture())).toBeUndefined();
  });

  it('stamps every record with runId, issue, laneId, phase, commandId and seq', () => {
    const records = collect();
    withCommandOutputCapture(corr, () => {
      const cap = openCommandCapture();
      cap?.write('stdout', enc('hello\n'));
      cap?.end();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ ...corr, commandId: cap?.commandId, seq: 0, stream: 'stdout', text: 'hello' });
      expect(Number.isNaN(Date.parse(records[0].ts))).toBe(false);
    });
  });

  it('numbers records per command from 0 across both streams', () => {
    const records = collect();
    withCommandOutputCapture(corr, () => {
      const a = openCommandCapture();
      a?.write('stdout', enc('o1\n'));
      a?.write('stderr', enc('e1\n'));
      a?.write('stdout', enc('o2\n'));
      const b = openCommandCapture();
      b?.write('stdout', enc('b1\n'));
      a?.end();
      b?.end();
    });
    expect(records.filter((r) => r.text !== 'b1').map((r) => [r.seq, r.stream])).toEqual([
      [0, 'stdout'],
      [1, 'stderr'],
      [2, 'stdout'],
    ]);
    expect(records.find((r) => r.text === 'b1')?.seq).toBe(0);
  });

  it('redacts credentials with the existing patterns before any sink sees the record', () => {
    const records = collect();
    const secrets = [
      ['sk', '-', 'abcdefghij0123456789ABCD'].join(''),
      ['Bearer', ' ', 'abcdefghij0123456789'].join(''),
      ['to', 'ken', '=', 'supersecretvalue99'].join(''),
      ['envsecret', 'value', '12345'].join(''),
    ];
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = secrets[3];
    try {
      withCommandOutputCapture(corr, () => {
        const cap = openCommandCapture();
        cap?.write('stdout', enc(`${secrets.join('\n')}\n`));
        cap?.end();
      });
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prev;
    }
    expect(records.length).toBe(4);
    const all = JSON.stringify(records);
    for (const s of secrets) expect(all).not.toContain(s.replace(/^Bearer /, '').replace(/^token=/, ''));
  });

  it('a throwing sink does not stop other sinks', () => {
    disposers.push(
      addCommandOutputSink(() => {
        throw new Error('bad sink');
      }),
    );
    const records = collect();
    withCommandOutputCapture(corr, () => {
      const cap = openCommandCapture();
      cap?.write('stderr', enc('x\n'));
      cap?.end();
    });
    expect(records.map((r) => r.text)).toEqual(['x']);
  });

  it('the disposer removes the sink', () => {
    const records: CommandOutputRecord[] = [];
    const dispose = addCommandOutputSink((r) => records.push(r));
    dispose();
    expect(withCommandOutputCapture(corr, () => openCommandCapture())).toBeUndefined();
    expect(records).toEqual([]);
  });

  it('end is idempotent and ignores later writes', () => {
    const records = collect();
    withCommandOutputCapture(corr, () => {
      const cap = openCommandCapture();
      cap?.write('stdout', enc('tail'));
      cap?.end();
      cap?.end();
      cap?.write('stdout', enc('late\n'));
    });
    expect(records.map((r) => r.text)).toEqual(['tail']);
  });
});
