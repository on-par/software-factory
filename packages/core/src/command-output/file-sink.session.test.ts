import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import {
  COMMAND_STREAM_DIR_ENV,
  type CommandStreamIo,
  openCommandStream,
  startCommandStreamSession,
} from './file-sink.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const DONE = { exitCode: 0, signal: null, timedOut: false, maxBufferExceeded: false } as const;

function realIo(warnings: string[], failWriteAfter?: number): CommandStreamIo {
  let writes = 0;
  return {
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    open: (path) => openSync(path, 'ax'),
    write: (fd, data) => {
      if (failWriteAfter !== undefined && ++writes > failWriteAfter) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return writeSync(fd, data);
    },
    close: (fd) => closeSync(fd),
    warn: (message) => warnings.push(message),
  };
}

function session(dir: string) {
  const warnings: string[] = [];
  const exits: (() => void)[] = [];
  const env = { [COMMAND_STREAM_DIR_ENV]: dir };
  startCommandStreamSession({ version: '9.9.9' }, env, realIo(warnings), (fn) => exits.push(fn));
  const json = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, unknown>;
  const sessionFiles = () => readdirSync(dir).filter((n) => n.startsWith('session-'));
  return { env, warnings, exits, json, sessionFiles };
}

describe('startCommandStreamSession', () => {
  it('writes the start file at once and an end file with this session’s counts at exit', async () => {
    const dir = await dirs.make('sf-session-');
    const s = session(dir);

    const [start] = s.sessionFiles();
    expect(start).toMatch(new RegExp(`^session-\\d+-${process.pid}\\.json$`));
    expect(s.json(start)).toEqual({ format: 1, pid: process.pid, startedAt: expect.any(String), version: '9.9.9' });
    expect(s.exits).toHaveLength(1);

    openCommandStream(['true'], {}, s.env, realIo([]))?.end(DONE);
    const failing = openCommandStream(['false'], {}, s.env, realIo(s.warnings, 1));
    failing?.write('stdout', Buffer.from('lost'));
    failing?.end(DONE);
    // Command stream files share the session's process tag.
    const tag = start.replace(/^session-|\.json$/g, '');
    expect(readdirSync(dir).filter((n) => n.startsWith(`cmd-${tag}-`))).toHaveLength(2);

    s.exits[0]();
    const end = start.replace(/\.json$/, '-end.json');
    expect(s.json(end)).toEqual({
      format: 1,
      pid: process.pid,
      commands: 2,
      writeErrors: 2,
      unavailable: false,
      endedAt: expect.any(String),
    });
    expect(s.warnings).toEqual(['factory: command output stream incomplete: ENOSPC']);
  });

  it('reports unavailable when a command stream file cannot be created', async () => {
    const dir = await dirs.make('sf-session-');
    const s = session(dir);
    const io: CommandStreamIo = {
      ...realIo([]),
      open: () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
    };
    expect(openCommandStream(['true'], {}, s.env, io)).toBeUndefined();
    s.exits[0]();
    const end = s.sessionFiles().find((n) => n.endsWith('-end.json'));
    expect(s.json(String(end))).toMatchObject({ commands: 1, writeErrors: 0, unavailable: true });
  });

  it('warns through the stream warning when the session file cannot be created, and exit never throws', async () => {
    const dir = await dirs.make('sf-session-');
    chmodSync(dir, 0o500);
    try {
      const s = session(dir);
      expect(s.warnings).toEqual(['factory: command output stream unavailable: EACCES']);
      expect(() => s.exits.forEach((fn) => fn())).not.toThrow();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('never overwrites an existing session file', async () => {
    const dir = await dirs.make('sf-session-');
    session(dir);
    const again = session(dir);
    expect(again.warnings).toEqual(['factory: command output stream unavailable: EEXIST']);
    expect(again.sessionFiles()).toHaveLength(1);
  });

  it('does nothing when the stream dir is not set', () => {
    const exits: (() => void)[] = [];
    startCommandStreamSession({ version: '1' }, {}, realIo([]), (fn) => exits.push(fn));
    expect(exits).toEqual([]);
  });
});
