import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { runCommand, type CommandResult, type RunCommandOptions } from './command-runner.js';

const STREAM_ENV = 'FACTORY_COMMAND_STREAM_DIR';
/** The size a real checker's output reached before the in-memory tail dropped its beginning. */
const OBSERVED_LOSS_BYTES = 750_325;

const dirs = createTempDirs();
/** Collected for the whole file (not a vi spy, which is reset per test): the stream warning is emitted once
 *  per process, whichever test hits it first. */
const warnings: string[] = [];
const realWarn = console.warn;
beforeAll(() => {
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
});
afterAll(() => {
  console.warn = realWarn;
});
const streamWarnings = () => warnings.filter((msg) => msg.includes('command output stream unavailable'));
afterEach(async () => {
  vi.unstubAllEnvs();
  await dirs.cleanup();
});

/** Writes part 1 of each stream, then blocks until `release` exists (or SIGKILLs itself in crash mode), then writes part 2. */
const CHILD = `
const fs = require('fs');
const [dir, release, mode] = process.argv.slice(1);
const read = (n) => fs.readFileSync(dir + '/' + n);
const write = (s, b) => new Promise((r) => s.write(b, r));
(async () => {
  await write(process.stdout, read('out1'));
  await write(process.stderr, read('err1'));
  if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
  while (!fs.existsSync(release)) await new Promise((r) => setTimeout(r, 20));
  await write(process.stdout, read('out2'));
  await write(process.stderr, read('err2'));
})();
`;

interface Payload {
  dir: string;
  release: string;
  out: Buffer;
  err: Buffer;
  out1: Buffer;
  err1: Buffer;
}

async function payload(): Promise<Payload> {
  const dir = await dirs.make('sf-stream-payload-');
  const multibyte = 'é 漢字 🚀 ñ ü '.repeat(2_000);
  // marker line, multibyte UTF-8, then one very long (420 KB) line
  const part = (marker: string, fill: string) =>
    Buffer.from(`${marker}\n${multibyte}\n${fill.repeat(420_000)}\n`, 'utf-8');
  const out1 = Buffer.concat([part('BEGIN-STDOUT', 'o'), Buffer.from('MIDDLE-STDOUT\n')]);
  const out2 = Buffer.concat([part('AFTER-BARRIER-STDOUT', 'p'), Buffer.from('END-STDOUT\n')]);
  const err1 = Buffer.concat([part('BEGIN-STDERR', 'e'), Buffer.from('MIDDLE-STDERR\n')]);
  const err2 = Buffer.concat([part('AFTER-BARRIER-STDERR', 'f'), Buffer.from('END-STDERR\n')]);
  for (const [name, bytes] of Object.entries({ out1, out2, err1, err2 })) writeFileSync(join(dir, name), bytes);
  return {
    dir,
    release: join(dir, 'release'),
    out: Buffer.concat([out1, out2]),
    err: Buffer.concat([err1, err2]),
    out1,
    err1,
  };
}

const argv = (p: Payload, mode = 'normal') => [process.execPath, '-e', CHILD, p.dir, p.release, mode];

type StreamRecord = Record<string, unknown> & { type: string; seq: number };

/** Complete NDJSON lines of every stream file in `dir` (a trailing partial line is ignored). */
function streamFiles(dir: string): { name: string; records: StreamRecord[] }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf-8');
      const complete = text.slice(0, text.lastIndexOf('\n') + 1);
      return {
        name,
        records: complete
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as StreamRecord),
      };
    });
}

function streamBytes(records: StreamRecord[], stream: 'stdout' | 'stderr'): Buffer {
  return Buffer.concat(
    records.filter((r) => r.type === 'chunk' && r.stream === stream).map((r) => Buffer.from(String(r.data), 'base64')),
  );
}

function onlyRecords(dir: string): StreamRecord[] {
  const files = streamFiles(dir);
  expect(files).toHaveLength(1);
  return files[0].records;
}

const end = (records: StreamRecord[]) => records.find((r) => r.type === 'end');

async function baseline(p: Payload, mode: string, options: RunCommandOptions): Promise<CommandResult> {
  vi.stubEnv(STREAM_ENV, undefined);
  try {
    return await runCommand(argv(p, mode), options);
  } finally {
    vi.unstubAllEnvs();
  }
}

describe.each([
  ['attached', {}],
  ['detached', { onPgid: () => {}, killGraceMs: 200 }],
] as const)('runCommand live output stream (%s)', (_label, pathOptions: RunCommandOptions) => {
  it('streams each chunk while the child is still running, then reassembles byte-exact with an end record', async () => {
    const p = await payload();
    expect(p.out.length).toBeGreaterThan(OBSERVED_LOSS_BYTES);
    expect(p.err.length).toBeGreaterThan(OBSERVED_LOSS_BYTES);
    const streamDir = join(await dirs.make('sf-stream-out-'), 'streams');
    vi.stubEnv(STREAM_ENV, streamDir);

    let settled = false;
    const run = runCommand(argv(p), { ...pathOptions, timeoutMs: 60_000 }).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(
        () => {
          const records = onlyRecords(streamDir);
          const out = streamBytes(records, 'stdout').toString('utf-8');
          const err = streamBytes(records, 'stderr').toString('utf-8');
          expect(out).toContain('BEGIN-STDOUT');
          expect(out).toContain('MIDDLE-STDOUT');
          expect(err).toContain('BEGIN-STDERR');
          expect(err).toContain('MIDDLE-STDERR');
        },
        { timeout: 15_000, interval: 50 },
      );
      // The child is blocked on the barrier: it cannot have exited yet.
      expect(settled).toBe(false);
      expect(existsSync(p.release)).toBe(false);
      const midRun = onlyRecords(streamDir);
      expect(midRun[0]).toMatchObject({ type: 'start', seq: 0 });
      expect(end(midRun)).toBeUndefined();
      expect(streamBytes(midRun, 'stdout').toString('utf-8')).not.toContain('END-STDOUT');
    } finally {
      writeFileSync(p.release, '');
    }
    const result = await run;

    await vi.waitFor(() => expect(end(onlyRecords(streamDir))).toBeDefined(), { timeout: 5_000, interval: 20 });
    const records = onlyRecords(streamDir);
    expect(streamBytes(records, 'stdout').equals(p.out)).toBe(true);
    expect(streamBytes(records, 'stderr').equals(p.err)).toBe(true);
    expect(end(records)).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      maxBufferExceeded: false,
      complete: true,
      writeErrors: 0,
      bytes: { stdout: p.out.length, stderr: p.err.length },
    });
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i));
    const offsets = records.filter((r) => r.type === 'chunk' && r.stream === 'stdout');
    let expected = 0;
    for (const r of offsets) {
      expect(r.offset).toBe(expected);
      expected += Buffer.from(String(r.data), 'base64').length;
    }
    const start = records[0];
    expect(start).toMatchObject({ type: 'start', cwd: expect.any(String) });
    expect(String(start.cwd)).not.toContain('/');
    const [name] = readdirSync(streamDir);
    expect(name).toMatch(/^[A-Za-z0-9._-]+\.ndjson$/);
    expect(name).toMatch(/-\d{6}-/);

    const unstreamed = await baseline(p, 'normal', { ...pathOptions, timeoutMs: 60_000 });
    expect(result).toEqual(unstreamed);
    expect(result.ok).toBe(true);
    // execa strips one final newline on the attached path; the stream keeps every byte.
    expect(result.stdout.trimEnd() === p.out.toString('utf-8').trimEnd()).toBe(true);
  }, 90_000);

  it('streams bytes received past maxBuffer up to the kill', async () => {
    const p = await payload();
    const streamDir = await dirs.make('sf-stream-out-');
    vi.stubEnv(STREAM_ENV, streamDir);
    const maxBuffer = 100_000;

    const result = await runCommand(argv(p), { ...pathOptions, maxBuffer, timeoutMs: 30_000 });

    expect(result.ok).toBe(false);
    expect(result.killed).toBe(true);
    await vi.waitFor(() => expect(end(onlyRecords(streamDir))).toBeDefined(), { timeout: 5_000, interval: 20 });
    const records = onlyRecords(streamDir);
    const out = streamBytes(records, 'stdout');
    expect(out.length).toBeGreaterThan(maxBuffer);
    expect(out.equals(p.out1.subarray(0, out.length))).toBe(true);
    expect(end(records)).toMatchObject({ maxBufferExceeded: true, timedOut: false });
  }, 60_000);

  it('keeps every byte received before the child is SIGKILLed', async () => {
    const p = await payload();
    const streamDir = await dirs.make('sf-stream-out-');
    vi.stubEnv(STREAM_ENV, streamDir);

    const result = await runCommand(argv(p, 'crash'), { ...pathOptions, timeoutMs: 30_000 });

    await vi.waitFor(() => expect(end(onlyRecords(streamDir))).toBeDefined(), { timeout: 5_000, interval: 20 });
    const records = onlyRecords(streamDir);
    expect(streamBytes(records, 'stdout').equals(p.out1)).toBe(true);
    expect(streamBytes(records, 'stderr').equals(p.err1)).toBe(true);
    expect(end(records)).toMatchObject({ signal: 'SIGKILL', complete: true });
    expect(result).toEqual(await baseline(p, 'crash', { ...pathOptions, timeoutMs: 30_000 }));
  }, 60_000);

  it('warns once per process and leaves the command result unchanged when the stream directory is unwritable', async () => {
    const p = await payload();
    writeFileSync(p.release, '');
    const parent = await dirs.make('sf-stream-out-');
    const streamDir = join(parent, 'locked');
    mkdirSync(streamDir);
    chmodSync(streamDir, 0o500);
    vi.stubEnv(STREAM_ENV, streamDir);
    try {
      const result = await runCommand(argv(p), { ...pathOptions, timeoutMs: 60_000 });
      expect(readdirSync(streamDir)).toEqual([]);
      expect(result).toEqual(await baseline(p, 'normal', { ...pathOptions, timeoutMs: 60_000 }));
      expect(result.ok).toBe(true);
      // The baseline run turned streaming off; a second streamed run must not warn again.
      vi.stubEnv(STREAM_ENV, streamDir);
      await runCommand(argv(p), { ...pathOptions, timeoutMs: 60_000 });
      expect(streamWarnings()).toEqual(['factory: command output stream unavailable: EACCES']);
    } finally {
      chmodSync(streamDir, 0o700);
    }
  }, 90_000);
});
