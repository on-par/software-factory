import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { type OtlpTestCollector, startOtlpTestCollector } from '../testing/otlp-collector.js';
import type { CommandStreamSink } from './file-sink.js';
import {
  closeCommandOutputSession,
  endCommandOutputWhenDrained,
  openCommandOutput,
  startCommandOutputSession,
  withModelOutput,
} from './tap.js';

const dirs = createTempDirs();
let collector: OtlpTestCollector | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await closeCommandOutputSession('exit', 2_000);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await collector?.close();
  collector = undefined;
  await dirs.cleanup();
});

const DONE = { exitCode: 0, signal: null, timedOut: false, maxBufferExceeded: false } as const;

function fakeTap() {
  const ends: unknown[] = [];
  const tap: CommandStreamSink = { write: () => {}, end: (r) => void ends.push(r) };
  return { tap, ends };
}

describe('endCommandOutputWhenDrained', () => {
  it('ends at once when there are no open pipes', () => {
    const { tap, ends } = fakeTap();
    endCommandOutputWhenDrained(tap, [null, undefined], DONE);
    expect(ends).toHaveLength(1);
  });

  it('waits for open pipes to close', async () => {
    const { tap, ends } = fakeTap();
    const out = new PassThrough();
    const err = new PassThrough();
    endCommandOutputWhenDrained(tap, [out, err], DONE);
    out.destroy();
    await new Promise((r) => setImmediate(r));
    expect(ends).toHaveLength(0);
    err.destroy();
    await new Promise((r) => setImmediate(r));
    expect(ends).toHaveLength(1);
  });

  it('ends after a grace period when a pipe stays open', () => {
    vi.useFakeTimers();
    const { tap, ends } = fakeTap();
    endCommandOutputWhenDrained(tap, [new PassThrough()], DONE);
    expect(ends).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(ends).toHaveLength(1);
  });
});

describe('openCommandOutput', () => {
  async function bothSinks() {
    collector = await startOtlpTestCollector();
    const streamDir = join(await dirs.make('sf-tap-'), 'streams');
    vi.stubEnv('FACTORY_COMMAND_STREAM_DIR', streamDir);
    vi.stubEnv('FACTORY_COMMAND_OUTPUT_EXPORT', 'otlp');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.endpoint);
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');
    await startCommandOutputSession({ version: 't' });
    return streamDir;
  }

  it('fans one tap out to the raw file and the redacted OTLP sink under the same command id', async () => {
    const streamDir = await bothSinks();
    const tap = openCommandOutput(['node', 'x'], { cwd: '/a/b' });
    tap?.write('stdout', Buffer.from('raw password=hunter2hunter2\n'));
    tap?.end(DONE);
    await closeCommandOutputSession('exit', 5_000);
    const file = readdirSync(streamDir).find((n) => n.startsWith('cmd-'));
    const id = /^cmd-(\d+-\d+-\d{6})-/.exec(String(file))?.[1];
    const lines = readFileSync(join(streamDir, String(file)), 'utf-8')
      .trim()
      .split('\n');
    const chunk = JSON.parse(lines[1]) as { data: string };
    expect(Buffer.from(chunk.data, 'base64').toString()).toContain('hunter2hunter2');
    const out = collector?.records().find((r) => r.eventName === 'factory.command.output');
    expect(out?.attrs['factory.command.id']).toBe(id);
    expect(out?.body).not.toContain('hunter2hunter2');
  });

  it('keeps a model execution in the raw file only', async () => {
    const streamDir = await bothSinks();
    const tap = withModelOutput(() => openCommandOutput(['agent']));
    tap?.write('stdout', Buffer.from('model text\n'));
    tap?.end(DONE);
    const summary = await closeCommandOutputSession('exit', 5_000);
    expect(summary?.withheld).toBe(1);
    expect(readdirSync(streamDir).filter((n) => n.startsWith('cmd-'))).toHaveLength(1);
    expect(JSON.stringify(collector?.records())).not.toContain('model text');
  });

  it('opens no OTLP recorder once the session is closing', async () => {
    await bothSinks();
    vi.stubEnv('FACTORY_COMMAND_STREAM_DIR', '');
    const closing = closeCommandOutputSession('exit', 5_000);
    expect(openCommandOutput(['late'])).toBeUndefined();
    expect(closeCommandOutputSession('exit')).toBe(closing);
    await closing;
  });

  it('warns and stays off when OTEL_LOGS_EXPORTER names no otlp exporter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('FACTORY_COMMAND_STREAM_DIR', '');
    vi.stubEnv('FACTORY_COMMAND_OUTPUT_EXPORT', 'otlp');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:9');
    vi.stubEnv('OTEL_LOGS_EXPORTER', 'console');
    await startCommandOutputSession({ version: 't' });
    expect(openCommandOutput(['x'])).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain("OTEL_LOGS_EXPORTER has no 'otlp'");
  });
});
