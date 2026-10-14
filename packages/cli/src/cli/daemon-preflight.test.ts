// packages/cli/src/cli/daemon-preflight.test.ts — factoryd preflights `self-update --to` before draining (#2355)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAutoUpdateDeps,
  runAutoUpdateCycle,
  type AutoUpdateApplyResult,
  type AutoUpdateDeps,
  type InstallInfo,
} from './daemon.js';
import { runSelfUpdateCommand } from './self-update-exec.js';
import { initialUpdateState, readUpdateState, writeUpdateState } from './update-state.js';

let dir: string;
let stop: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  stop = join(dir, 'repo', 'STOP');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = {
  autoUpdate: {
    mode: 'stable' as const,
    requestedMode: 'stable' as const,
    channel: 'latest' as const,
    checkIntervalMinutes: 30,
    drainTimeoutMinutes: 60,
  },
  install: { kind: 'npm-global', version: '0.9.0', prefix: '/usr/local' } as InstallInfo,
};
const OK: AutoUpdateApplyResult = { code: 0, rolledBack: false, error: null };

function fakeDeps(over: { preflight?: AutoUpdateApplyResult; apply?: AutoUpdateApplyResult } = {}) {
  const stateFile = join(dir, 'update-state.json');
  writeUpdateState(stateFile, initialUpdateState(config, null));
  const logs: string[] = [];
  const deps: AutoUpdateDeps = {
    stateFile,
    check: vi.fn(async () => ({ candidate: '0.9.1', updateAvailable: true, error: null })),
    preflight: vi.fn(async () => over.preflight ?? OK),
    apply: vi.fn(async () => over.apply ?? OK),
    activeRuns: vi.fn(async () => []),
    writeStops: vi.fn(async () => {
      mkdirSync(join(dir, 'repo'), { recursive: true });
      writeFileSync(stop, '');
      return [stop];
    }),
    clearStops: vi.fn(async (files: string[]) => {
      for (const f of files) rmSync(f, { force: true });
    }),
    now: () => Date.parse('2026-10-13T20:14:00-05:00'),
    sleep: async () => {},
    log: (l) => logs.push(l),
    exit: () => {},
  };
  return { deps, logs, stateFile };
}

describe('runAutoUpdateCycle preflight', () => {
  it('a failing preflight never writes STOP, never applies, and records skipped (the 8:14 PM bug)', async () => {
    const f = fakeDeps({ preflight: { code: 1, rolledBack: false, error: "error: unknown option '--to'" } });
    expect(await runAutoUpdateCycle(config, f.deps)).toBe('preflight-failed');
    expect(f.deps.preflight).toHaveBeenCalledWith('0.9.1');
    expect(f.deps.writeStops).not.toHaveBeenCalled();
    expect(f.deps.activeRuns).not.toHaveBeenCalled();
    expect(f.deps.apply).not.toHaveBeenCalled();
    expect(existsSync(stop)).toBe(false);
    const state = readUpdateState(f.stateFile);
    expect(state?.draining).toBeNull();
    expect(state?.lastResult).toMatchObject({ outcome: 'skipped', version: '0.9.1' });
    expect(state?.lastResult?.error).toContain("unknown option '--to'");
    expect(f.logs.some((l) => l.includes('not draining'))).toBe(true);
  });

  it('a throwing preflight is a preflight failure, not a drain', async () => {
    const f = fakeDeps();
    vi.mocked(f.deps.preflight).mockRejectedValue(new Error('spawn ENOENT'));
    expect(await runAutoUpdateCycle(config, f.deps)).toBe('preflight-failed');
    expect(f.deps.writeStops).not.toHaveBeenCalled();
    expect(readUpdateState(f.stateFile)?.lastResult?.error).toContain('spawn ENOENT');
  });

  it('preflights before draining, and clears STOP after a failed apply so builds resume', async () => {
    const f = fakeDeps({ apply: { code: 1, rolledBack: true, error: 'doctor failed' } });
    expect(await runAutoUpdateCycle(config, f.deps)).toBe('failed');
    const pre = vi.mocked(f.deps.preflight).mock.invocationCallOrder[0]!;
    const drain = vi.mocked(f.deps.writeStops).mock.invocationCallOrder[0]!;
    expect(pre).toBeLessThan(drain);
    expect(existsSync(stop)).toBe(false);
    expect(readUpdateState(f.stateFile)).toMatchObject({ draining: null, lastResult: { outcome: 'rolled-back' } });
  });

  it('updates after a passing preflight', async () => {
    const f = fakeDeps();
    expect(await runAutoUpdateCycle(config, f.deps)).toBe('updated');
    expect(f.deps.apply).toHaveBeenCalledWith('0.9.1');
    expect(existsSync(stop)).toBe(false);
  });
});

describe('createAutoUpdateDeps preflight/apply commands', () => {
  function cli(body: string): string {
    const file = join(dir, `cli-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, body);
    return file;
  }
  function deps(entrypoint: string) {
    const registryFile = join(dir, 'registry.json');
    writeFileSync(registryFile, JSON.stringify({ version: 1, repos: {} }));
    return createAutoUpdateDeps({
      registryFile,
      stateFile: join(dir, 'update-state.json'),
      cliEntrypoint: entrypoint,
      check: async () => ({ candidate: null, updateAvailable: false, error: null }),
      runRuntime: { list: () => [] },
      log: () => {},
      exit: () => {},
    });
  }

  it('preflight runs `self-update --to <v> --dry-run --force --json`; apply runs `--to <v> --no-restart --json`', async () => {
    const argsFile = join(dir, 'args.log');
    const d = deps(
      cli(
        `import { appendFileSync } from 'node:fs';appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');process.stdout.write('{}');`,
      ),
    );
    expect(await d.preflight('0.9.1')).toEqual(OK);
    expect(await d.apply('0.9.1')).toEqual(OK);
    const calls = readFileSync(argsFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    expect(calls).toEqual([
      ['self-update', '--to', '0.9.1', '--dry-run', '--force', '--json'],
      ['self-update', '--to', '0.9.1', '--no-restart', '--json'],
    ]);
  });

  it('preflight against a CLI without --to fails without throwing', async () => {
    const d = deps(cli(`process.stderr.write("error: unknown option '--to'\\n");process.exit(1);`));
    expect(await d.preflight('0.9.1')).toEqual({ code: 1, rolledBack: false, error: "error: unknown option '--to'" });
  });

  it('runSelfUpdateCommand prefers the JSON error, then stderr, then the exit code', async () => {
    const exec = (code: number, stdout: string, stderr: string) => async () => ({ code, stdout, stderr });
    expect(await runSelfUpdateCommand(exec(1, '{"outcome":"rolled-back","error":"doctor"}', 'x'), 'c', [])).toEqual({
      code: 1,
      rolledBack: true,
      error: 'doctor',
    });
    expect(await runSelfUpdateCommand(exec(4, '[1]', 'a\nnpm ERR!\n'), 'c', [])).toMatchObject({ error: 'npm ERR!' });
    expect(await runSelfUpdateCommand(exec(5, 'nope', ''), 'c', [])).toMatchObject({ error: 'exit 5' });
    expect(await runSelfUpdateCommand(exec(0, '', ''), 'c', [])).toEqual(OK);
  });
});
