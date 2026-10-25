import { constants } from 'node:fs';
import { readdir, mkdir, open, stat, rm } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { join } from 'node:path';

import { redactText } from '../filing/redact.js';
import type { RouterResult } from '../router/index.js';
import type { WorkKey } from '../work/index.js';

const MAX_BYTES = 1_048_576;
const MARKER = /\n\[truncated (\d+) bytes\]$/;

export interface RunPhaseLogOptions {
  logsDir?: string;
  issue: WorkKey;
  runId: string;
  phase: 'plan' | 'build' | `build-r${number}`;
  result: RouterResult;
  log: (type: 'warn', message: string) => void;
}

export interface RunPhaseLogger {
  plan(result: RouterResult): Promise<void>;
  build(result: RouterResult): Promise<void>;
  rework(result: RouterResult): Promise<void>;
  parkMessage(message: string): string;
}

function section(result: RouterResult): string {
  const attempts = result.attempts.map(
    (attempt) =>
      `attempt model=${attempt.model} ok=${attempt.ok} reason=${attempt.reason ?? 'none'} duration=unknown${attempt.detail ? ` detail=${attempt.detail}` : ''}`,
  );
  return `${attempts.length ? `${attempts.join('\n')}\n` : ''}final model=${result.model} exitCode=${result.exitCode}\n${result.output}\n`;
}

function utf8Prefix(input: string, bytes: number): string {
  let out = '';
  let used = 0;
  for (const char of input) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > bytes) break;
    out += char;
    used += size;
  }
  return out;
}

function unpack(content: string): { content: string; omitted: number } {
  const match = MARKER.exec(content);
  return match ? { content: content.slice(0, match.index), omitted: Number(match[1]) } : { content, omitted: 0 };
}

async function prune(issueDir: string, current: string): Promise<void> {
  const entries = await readdir(issueDir, { withFileTypes: true });
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
      .map(async (entry) => ({
        name: entry.name,
        mtime: (await stat(join(issueDir, entry.name))).mtimeMs,
      })),
  );
  runs.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const keep = new Set([
    current,
    ...runs
      .filter((run) => run.name !== current)
      .slice(0, 4)
      .map((run) => run.name),
  ]);
  await Promise.all(
    runs
      .filter((run) => !keep.has(run.name))
      .map((run) => rm(join(issueDir, run.name), { recursive: true, force: true })),
  );
}

export async function writeRunPhaseLog(opts: RunPhaseLogOptions): Promise<string | undefined> {
  if (!opts.logsDir) return undefined;
  const issueDir = join(opts.logsDir, `issue-${opts.issue}`);
  const runDir = join(issueDir, `run-${opts.runId}`);
  const path = join(runDir, `${opts.phase}.log`);
  try {
    const cleanSection = redactText(stripVTControlCharacters(section(opts.result)));
    await mkdir(runDir, { recursive: true });
    // One descriptor for the read and the rewrite, so the file can't be swapped between them.
    const handle = await open(path, constants.O_RDWR | constants.O_CREAT, 0o600);
    try {
      const buffer = Buffer.alloc(MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, 0);
      const content = appendCapped(buffer.subarray(0, bytesRead).toString('utf8'), cleanSection);
      await handle.truncate(0);
      await handle.write(content, 0, 'utf8');
    } finally {
      await handle.close();
    }
  } catch {
    opts.log('warn', `run phase log write failed for ${opts.phase}`);
    return undefined;
  }
  try {
    await prune(issueDir, `run-${opts.runId}`);
  } catch {
    opts.log('warn', 'run phase log pruning failed');
  }
  return runDir;
}

function appendCapped(prior: string, section: string): string {
  const unpacked = unpack(prior);
  let content = `${unpacked.content}${section}`;
  if (unpacked.omitted > 0 || Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    const total = Buffer.byteLength(content, 'utf8') + unpacked.omitted;
    const marker = (omitted: number): string => `\n[truncated ${omitted} bytes]`;
    let omitted = total;
    for (;;) {
      const prefix = utf8Prefix(content, MAX_BYTES - Buffer.byteLength(marker(omitted), 'utf8'));
      const next = total - Buffer.byteLength(prefix, 'utf8');
      if (next === omitted) {
        content = `${prefix}${marker(omitted)}`;
        break;
      }
      omitted = next;
    }
  }
  return content;
}

export function createRunPhaseLogger(opts: {
  logsDir?: string;
  issue: WorkKey;
  runId: string;
  log: (type: 'warn', message: string) => void;
}): RunPhaseLogger {
  let directory: string | undefined;
  let reworkRound = 0;
  const record = async (phase: RunPhaseLogOptions['phase'], result: RouterResult): Promise<void> => {
    const written = await writeRunPhaseLog({ ...opts, phase, result });
    directory = written ?? directory;
  };
  return {
    plan: (result) => record('plan', result),
    build: (result) => record('build', result),
    rework: (result) => record(`build-r${++reworkRound}`, result),
    parkMessage: (message) =>
      directory
        ? `${message}\nRun logs: ${directory.replace(/[\r\n]/g, (c) => (c === '\r' ? '\\r' : '\\n'))}`
        : message,
  };
}
