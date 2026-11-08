// src/command-output/file-sink.ts — opt-in live NDJSON file of a command's raw stdout/stderr, written as it arrives.

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

import { redactGitHubCredentials } from '../utils/github-credentials.js';
import { fileStats as stats, nextCommandId, PROCESS_TAG, warnOnce as warnOnceMessage } from './state.js';

/** When set on the factory process, every command run through the command runners streams its output into this dir. */
export const COMMAND_STREAM_DIR_ENV = 'FACTORY_COMMAND_STREAM_DIR';

export type OutputStream = 'stdout' | 'stderr';

export interface CommandStreamEnd {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  maxBufferExceeded: boolean;
}

export interface CommandStreamSink {
  /** Appends one received chunk. A string chunk was decoded by a runner that never exposes raw bytes. */
  write(stream: OutputStream, chunk: Buffer | string): void;
  /** Writes the end record and closes the file. Later writes and ends are ignored. */
  end(result: CommandStreamEnd): void;
}

/** An open stream file and the command id its name carries. */
export interface CommandStreamFile extends CommandStreamSink {
  readonly id: string;
}

/** File and warning seam so tests can fail a write mid-stream and capture warnings. */
export interface CommandStreamIo {
  mkdir(dir: string): void;
  open(path: string): number;
  write(fd: number, data: Buffer): number;
  close(fd: number): void;
  warn(message: string): void;
}

const nodeIo: CommandStreamIo = {
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  open: (path) => openSync(path, 'ax'),
  write: (fd, data) => writeSync(fd, data),
  close: (fd) => closeSync(fd),
  warn: (message) => console.warn(message),
};

function warnOnce(io: CommandStreamIo, state: 'unavailable' | 'incomplete', err: unknown): void {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN';
  warnOnceMessage(`factory: command output stream ${state}: ${code}`, io.warn);
}

/** Writes one whole file that must not already exist; throws on any failure. */
function writeNewFile(io: CommandStreamIo, path: string, value: unknown): void {
  const fd = io.open(path);
  try {
    const data = Buffer.from(`${JSON.stringify(value)}\n`, 'utf-8');
    let off = 0;
    while (off < data.length) off += io.write(fd, data.subarray(off));
  } finally {
    io.close(fd);
  }
}

/** Marks the start of a CLI process that streams command output: writes `session-<tag>.json` (format 1) into
 *  the stream dir at once, and `session-<tag>-end.json` with this session's counts from a synchronous exit
 *  handler. A consumer can then tell "streaming, no commands ran" (start and end, `commands: 0`) apart from
 *  an older CLI (no session file). Does nothing when streaming is off; never throws. A file that cannot be
 *  created warns `unavailable` once and is reported as `unavailable: true` in the end file. */
export function startCommandStreamSession(
  opts: { version: string },
  env: NodeJS.ProcessEnv = process.env,
  io: CommandStreamIo = nodeIo,
  onExit: (fn: () => void) => void = (fn) => {
    process.once('exit', fn);
  },
): void {
  const dir = env[COMMAND_STREAM_DIR_ENV]?.trim();
  if (!dir) return;
  stats.commands = 0;
  stats.writeErrors = 0;
  stats.unavailable = false;
  const write = (suffix: string, value: Record<string, unknown>) => {
    try {
      io.mkdir(dir);
      writeNewFile(io, join(dir, `session-${PROCESS_TAG}${suffix}.json`), { format: 1, pid: process.pid, ...value });
    } catch (err) {
      stats.unavailable = true;
      warnOnce(io, 'unavailable', err);
    }
  };
  write('', { startedAt: new Date().toISOString(), version: opts.version });
  onExit(() =>
    write('-end', {
      commands: stats.commands,
      writeErrors: stats.writeErrors,
      unavailable: stats.unavailable,
      endedAt: new Date().toISOString(),
    }),
  );
}

/** File-name-safe label from the program name and its first two arguments; never a caller-supplied path. */
function commandLabel(argv: readonly string[]): string {
  const words = [basename(argv[0] ?? 'command'), ...argv.slice(1, 3)];
  return (
    words
      .join('-')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|-+$/g, '')
      .slice(0, 60) || 'command'
  );
}

/** Opens a stream file for one command invocation, or returns undefined when streaming is off or the file
 *  cannot be created. The stream is a diagnostic side channel: no method ever throws, and a failed write
 *  only marks the stream incomplete (`complete: false` and `writeErrors` on the end record). A file that
 *  cannot be created or whose first write fails warns `unavailable`, a later failed write warns
 *  `incomplete`; each once per process per errno code. */
export function openCommandStream(
  argv: readonly string[],
  opts: { cwd?: string; shell?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
  io: CommandStreamIo = nodeIo,
): CommandStreamFile | undefined {
  const dir = env[COMMAND_STREAM_DIR_ENV]?.trim();
  if (!dir) return undefined;
  stats.commands++;

  let fd: number;
  let id: string;
  try {
    io.mkdir(dir);
    ({ fd, id } = openUnique(dir, commandLabel(opts.shell ? (argv[0] ?? '').trim().split(/\s+/) : argv), io));
  } catch (err) {
    stats.unavailable = true;
    warnOnce(io, 'unavailable', err);
    return undefined;
  }

  let seq = 0;
  let writeErrors = 0;
  let failed = false;
  let closed = false;
  const bytes: Record<OutputStream, number> = { stdout: 0, stderr: 0 };

  const append = (record: Record<string, unknown>): void => {
    // After a failed write the file may end in a torn line; a leading newline keeps the next record parseable.
    const lead = failed ? '\n' : '';
    const n = seq++;
    const line = Buffer.from(`${lead}${JSON.stringify({ seq: n, ts: Date.now(), ...record })}\n`, 'utf-8');
    try {
      let off = 0;
      while (off < line.length) off += io.write(fd, line.subarray(off));
    } catch (err) {
      if (!failed) warnOnce(io, n === 0 ? 'unavailable' : 'incomplete', err);
      if (n === 0) stats.unavailable = true;
      stats.writeErrors++;
      writeErrors++;
      failed = true;
    }
  };

  append({
    type: 'start',
    argv: argv.map((arg) => redactGitHubCredentials(arg)),
    shell: opts.shell === true,
    cwd: basename(opts.cwd ?? process.cwd()),
    pid: process.pid,
  });

  return {
    id,
    write(stream, chunk) {
      if (closed) return;
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
      const offset = bytes[stream];
      bytes[stream] += data.length;
      // Once a write has failed the byte sequence has a gap: stop appending chunks and let the end record say so.
      if (failed) return;
      append({
        type: 'chunk',
        stream,
        offset,
        ...(typeof chunk === 'string' ? { decoded: true } : {}),
        data: data.toString('base64'),
      });
    },
    end(result) {
      if (closed) return;
      closed = true;
      append({ type: 'end', ...result, bytes: { ...bytes }, complete: !failed, writeErrors });
      try {
        io.close(fd);
      } catch {
        // nothing left to report to
      }
    },
  };
}

function openUnique(dir: string, label: string, io: CommandStreamIo): { fd: number; id: string } {
  for (;;) {
    const id = nextCommandId();
    try {
      return { fd: io.open(join(dir, `cmd-${id}-${label}.ndjson`)), id };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}
