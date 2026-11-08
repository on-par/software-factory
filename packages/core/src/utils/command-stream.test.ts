import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import {
  COMMAND_STREAM_DIR_ENV,
  type CommandStreamIo,
  endCommandStreamWhenDrained,
  openCommandStream,
} from './command-stream.js';

const dirs = createTempDirs();
afterEach(async () => {
  vi.useRealTimers();
  await dirs.cleanup();
});

const DONE = { exitCode: 0, signal: null, timedOut: false, maxBufferExceeded: false } as const;

function records(dir: string): { name: string; lines: Record<string, unknown>[] } {
  const [name] = readdirSync(dir);
  const text = readFileSync(join(dir, name), 'utf-8');
  return {
    name,
    lines: text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** In-memory io that can fail chosen write calls (1-based) and split writes into short writes. */
function memoryIo(opts: { failWrites?: number[]; writeCode?: string; shortWrites?: boolean; failOpen?: string } = {}) {
  let calls = 0;
  const opened: string[] = [];
  const chunks: Buffer[] = [];
  const warnings: string[] = [];
  const io: CommandStreamIo = {
    warn: (message) => warnings.push(message),
    mkdir: () => {},
    open: (path) => {
      if (opts.failOpen) throw Object.assign(new Error(opts.failOpen), { code: opts.failOpen });
      opened.push(path);
      return 7;
    },
    write: (_fd, data) => {
      calls++;
      if (opts.failWrites?.includes(calls)) {
        const code = opts.writeCode ?? 'ENOSPC';
        throw Object.assign(new Error(code), { code });
      }
      const n = opts.shortWrites ? Math.max(1, Math.floor(data.length / 2)) : data.length;
      chunks.push(Buffer.from(data.subarray(0, n)));
      return n;
    },
    close: () => {},
  };
  const lines = () =>
    Buffer.concat(chunks)
      .toString('utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { io, opened, lines, warnings };
}

describe('openCommandStream', () => {
  it('is off unless the stream dir is set', () => {
    expect(openCommandStream(['true'], {}, {})).toBeUndefined();
    expect(openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '  ' })).toBeUndefined();
  });

  it('writes start, chunk and end records with per-stream offsets and a safe unique name', async () => {
    const dir = await dirs.make('sf-cmd-stream-');
    const env = { [COMMAND_STREAM_DIR_ENV]: dir, GH_TOKEN: 'ghp_abcdefghijklmnop' };
    const sink = openCommandStream(['/usr/local/bin/npm', 'run', 'test:unit', '../../etc'], { cwd: '/x/repo' }, env);
    sink?.write('stdout', Buffer.from('ab'));
    sink?.write('stderr', Buffer.from([0xff, 0x00]));
    sink?.write('stdout', 'é');
    sink?.end({ ...DONE, exitCode: 2 });
    sink?.write('stdout', Buffer.from('late'));
    sink?.end(DONE);

    const { name, lines } = records(dir);
    expect(name).toMatch(/^cmd-\d+-\d+-\d{6}-npm-run-test-unit\.ndjson$/);
    expect(lines.map((l) => l.type)).toEqual(['start', 'chunk', 'chunk', 'chunk', 'end']);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(lines[0]).toMatchObject({ cwd: 'repo', shell: false });
    expect(lines[1]).toMatchObject({ stream: 'stdout', offset: 0, data: Buffer.from('ab').toString('base64') });
    expect(lines[2]).toMatchObject({ stream: 'stderr', offset: 0, data: Buffer.from([0xff, 0x00]).toString('base64') });
    expect(lines[3]).toMatchObject({ stream: 'stdout', offset: 2, decoded: true });
    expect(lines[4]).toMatchObject({
      exitCode: 2,
      bytes: { stdout: 4, stderr: 2 },
      complete: true,
      writeErrors: 0,
    });
  });

  it('redacts GitHub tokens in the start record argv only', async () => {
    const dir = await dirs.make('sf-cmd-stream-');
    const argv = ['git', 'push', 'https://x:ghp_secretsecret123@github.com/o/r'];
    const sink = openCommandStream(argv, {}, { [COMMAND_STREAM_DIR_ENV]: dir });
    sink?.write('stdout', Buffer.from('ghp_secretsecret123'));
    sink?.end(DONE);
    const { lines } = records(dir);
    expect(JSON.stringify(lines[0].argv)).not.toContain('ghp_secretsecret123');
    expect(Buffer.from(String(lines[1].data), 'base64').toString()).toBe('ghp_secretsecret123');
  });

  it('labels a shell command from its first words', () => {
    const mem = memoryIo();
    openCommandStream(['npm test -- --run'], { shell: true }, { [COMMAND_STREAM_DIR_ENV]: '/d' }, mem.io);
    expect(mem.opened[0]).toMatch(/^\/d\/cmd-\d+-\d+-\d{6}-npm-test\.ndjson$/);
  });

  it('retries the next sequence number when a name already exists', () => {
    let attempts = 0;
    const mem = memoryIo();
    const io: CommandStreamIo = {
      ...mem.io,
      open: (path) => {
        if (++attempts === 1) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        return mem.io.open(path);
      },
    };
    expect(openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, io)).toBeDefined();
    expect(attempts).toBe(2);
  });

  it('returns undefined when the file cannot be created', () => {
    const mem = memoryIo({ failOpen: 'EPERM' });
    expect(openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, mem.io)).toBeUndefined();
    expect(openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, mem.io)).toBeUndefined();
    const io: CommandStreamIo = {
      ...mem.io,
      mkdir: () => {
        throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      },
    };
    expect(openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, io)).toBeUndefined();
    expect(openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, io)).toBeUndefined();
    // One warning per failure kind per process, never one per command.
    expect(mem.warnings).toEqual([
      'factory: command output stream unavailable: EPERM',
      'factory: command output stream unavailable: EROFS',
    ]);
  });

  it('warns once when the first write fails, then returns a sink that never throws', () => {
    const mem = memoryIo({ failWrites: [1, 2, 3, 4], writeCode: 'EDQUOT' });
    const sink = openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, mem.io);
    expect(() => {
      sink?.write('stdout', Buffer.from('one'));
      sink?.end(DONE);
    }).not.toThrow();
    openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, mem.io)?.end(DONE);
    expect(mem.warnings).toEqual(['factory: command output stream unavailable: EDQUOT']);
  });

  it('completes short writes', () => {
    const mem = memoryIo({ shortWrites: true });
    const sink = openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, mem.io);
    sink?.write('stdout', Buffer.from('hello'));
    sink?.end(DONE);
    expect(mem.lines().map((l) => l.type)).toEqual(['start', 'chunk', 'end']);
  });

  it('marks the stream incomplete after a failed write and never throws', () => {
    const mem = memoryIo({ failWrites: [3] });
    const sink = openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, mem.io);
    expect(() => {
      sink?.write('stdout', Buffer.from('one'));
      sink?.write('stdout', Buffer.from('two'));
      sink?.write('stderr', Buffer.from('three'));
      sink?.end(DONE);
    }).not.toThrow();
    const lines = mem.lines();
    expect(lines.map((l) => l.type)).toEqual(['start', 'chunk', 'end']);
    expect(lines.at(-1)).toMatchObject({ complete: false, writeErrors: 1, bytes: { stdout: 6, stderr: 5 } });
    expect(mem.warnings).toEqual(['factory: command output stream incomplete: ENOSPC']);
  });

  it('survives a failing close', () => {
    const mem = memoryIo();
    const io: CommandStreamIo = {
      ...mem.io,
      close: () => {
        throw new Error('EIO');
      },
    };
    const sink = openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, io);
    expect(() => sink?.end(DONE)).not.toThrow();
  });
});

describe('endCommandStreamWhenDrained', () => {
  const sink = () => {
    const mem = memoryIo();
    return { mem, sink: openCommandStream(['true'], {}, { [COMMAND_STREAM_DIR_ENV]: '/d' }, mem.io)! };
  };
  const ended = (mem: ReturnType<typeof memoryIo>) => mem.lines().some((l) => l.type === 'end');

  it('ends at once when there are no open pipes', () => {
    const s = sink();
    endCommandStreamWhenDrained(s.sink, [null, undefined], DONE);
    expect(ended(s.mem)).toBe(true);
  });

  it('waits for open pipes to close', async () => {
    const s = sink();
    const out = new PassThrough();
    const err = new PassThrough();
    endCommandStreamWhenDrained(s.sink, [out, err], DONE);
    out.destroy();
    await new Promise((r) => setImmediate(r));
    expect(ended(s.mem)).toBe(false);
    err.destroy();
    await new Promise((r) => setImmediate(r));
    expect(ended(s.mem)).toBe(true);
  });

  it('ends after a grace period when a pipe stays open', () => {
    vi.useFakeTimers();
    const s = sink();
    endCommandStreamWhenDrained(s.sink, [new PassThrough()], DONE);
    expect(ended(s.mem)).toBe(false);
    vi.advanceTimersByTime(300);
    expect(ended(s.mem)).toBe(true);
  });
});
