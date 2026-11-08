import { afterEach, describe, expect, it } from 'vitest';

import {
  type CommandOutputCorrelation,
  type CommandOutputRecord,
  openCommandCapture,
  registerCommandOutputSink,
  withCommandOutputScope,
} from './capture.js';

const corr: CommandOutputCorrelation = { runId: 'run-1', issue: 'gh:7', lane: 'lane-a', phase: 'check' };
const fakeToken = () => ['gh', 'p', '_'].join('') + 'a1B2'.repeat(9);

const unregs: Array<() => void> = [];
afterEach(() => {
  while (unregs.length) unregs.pop()?.();
});

function collect(): CommandOutputRecord[] {
  const records: CommandOutputRecord[] = [];
  unregs.push(registerCommandOutputSink((r) => records.push(r)));
  return records;
}

describe('command output capture (#3994)', () => {
  it('opens no capture outside a scope', () => {
    collect();
    expect(openCommandCapture()).toBeUndefined();
  });

  it('opens no capture with no sink registered', async () => {
    await withCommandOutputScope(corr, async () => {
      expect(openCommandCapture()).toBeUndefined();
    });
  });

  it('stamps run id, issue, lane, phase, command id and sequence number on every record', async () => {
    const records = collect();
    await withCommandOutputScope(corr, async () => {
      const c = openCommandCapture({ now: () => new Date('2026-01-01T00:00:00.000Z') });
      c?.onChunk('stdout', 'hi\n');
    });
    expect(records).toEqual([
      { ...corr, commandId: 'cmd-0', seq: 0, stream: 'stdout', text: 'hi\n', time: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('numbers seq from 0 per command across both streams', async () => {
    const records = collect();
    await withCommandOutputScope(corr, async () => {
      const a = openCommandCapture();
      const b = openCommandCapture();
      a?.onChunk('stdout', 'a\n');
      a?.onChunk('stderr', 'b\n');
      b?.onChunk('stderr', 'c\n');
    });
    expect(records.map((r) => [r.commandId, r.seq, r.stream])).toEqual([
      ['cmd-0', 0, 'stdout'],
      ['cmd-0', 1, 'stderr'],
      ['cmd-1', 0, 'stderr'],
    ]);
  });

  it('gives each command in a scope a distinct command id', async () => {
    collect();
    await withCommandOutputScope(corr, async () => {
      const ids = [openCommandCapture(), openCommandCapture(), openCommandCapture()].map((c) => c?.commandId);
      expect(new Set(ids).size).toBe(3);
    });
  });

  it('sinks only ever see redacted text', async () => {
    const records = collect();
    const t = fakeToken();
    await withCommandOutputScope(corr, async () => {
      const c = openCommandCapture({ env: {} });
      c?.onChunk('stdout', t.slice(0, 12));
      expect(records).toEqual([]);
      c?.onChunk('stdout', `${t.slice(12)}\n`);
      c?.close();
    });
    expect(records.map((r) => r.text).join('')).not.toContain(t.slice(0, 12));
  });

  it('a throwing sink does not stop other sinks or throw from onChunk', async () => {
    unregs.push(
      registerCommandOutputSink(() => {
        throw new Error('boom');
      }),
    );
    const records = collect();
    await withCommandOutputScope(corr, async () => {
      const c = openCommandCapture();
      expect(() => c?.onChunk('stdout', 'x\n')).not.toThrow();
    });
    expect(records).toHaveLength(1);
  });

  it('close flushes held partial lines and is idempotent', async () => {
    const records = collect();
    await withCommandOutputScope(corr, async () => {
      const c = openCommandCapture();
      c?.onChunk('stdout', 'out');
      c?.onChunk('stderr', 'err');
      c?.close();
      c?.close();
      c?.onChunk('stdout', 'late\n');
    });
    expect(records.map((r) => [r.stream, r.text])).toEqual([
      ['stdout', 'out'],
      ['stderr', 'err'],
    ]);
  });
});
