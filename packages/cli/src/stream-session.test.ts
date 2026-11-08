import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** Runs the real CLI entry (TypeScript sources via tsx) in a child process. */
function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--conditions=development', '--import', 'tsx', CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

describe('CLI command stream session files', () => {
  it('writes a session start and end file before and after any command', async () => {
    const streamDir = join(await dirs.make('sf-cli-session-'), 'streams');

    const r = runCli(['--version'], { FACTORY_COMMAND_STREAM_DIR: streamDir });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
    const files = readdirSync(streamDir);
    expect(files).toHaveLength(2);
    const start = String(files.find((n) => !n.endsWith('-end.json')));
    const end = String(files.find((n) => n.endsWith('-end.json')));
    expect(start).toMatch(new RegExp(`^session-\\d+-${r.pid}\\.json$`));
    expect(end).toBe(start.replace(/\.json$/, '-end.json'));
    const startJson = JSON.parse(readFileSync(join(streamDir, start), 'utf-8')) as Record<string, unknown>;
    expect(startJson).toEqual({ format: 1, pid: r.pid, startedAt: expect.any(String), version: VERSION });
    const endJson = JSON.parse(readFileSync(join(streamDir, end), 'utf-8')) as Record<string, unknown>;
    expect(endJson).toEqual({
      format: 1,
      pid: r.pid,
      commands: 0,
      writeErrors: 0,
      unavailable: false,
      endedAt: expect.any(String),
    });
    expect(Date.parse(String(endJson.endedAt))).toBeGreaterThanOrEqual(Date.parse(String(startJson.startedAt)));
  }, 90_000);

  it('writes no session file when the stream dir is not set', () => {
    const r = runCli(['--version'], { FACTORY_COMMAND_STREAM_DIR: '' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
    expect(readdirSync(process.cwd()).filter((n) => n.startsWith('session-'))).toEqual([]);
  }, 90_000);
});
