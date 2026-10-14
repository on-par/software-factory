// packages/cli/src/cli/self-update-apply.test.ts — factory self-update --to (#2355)
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliExitError, type CliDeps, type ProgramHandlers } from './index.js';
import { registerAdvancedCommands } from './program-advanced.js';

import {
  applySelfUpdate,
  attachedRunLocks,
  cmdSelfUpdateApply,
  failingDoctorChecks,
  formatApplyResult,
  stableVersionError,
  type ApplyExec,
  type SelfUpdateApplyDeps,
} from './self-update-apply.js';
import { buildStatusUpdateJson, formatUpdateStatusLine, readUpdateState, writeUpdateState } from './update-state.js';

const PREFIX = '/usr/local';
const NPM = '/usr/local/bin/npm';
const NODE = '/usr/local/bin/node';
const CLI = '/usr/local/lib/node_modules/@on-par/factory-cli/dist/cli.js';

type Reply = { code: number; stdout?: string; stderr?: string };

/** Stub runner: tracks the installed version so `--version` reflects the last successful install. */
function stubExec(opts: {
  installed?: string;
  install?: (spec: string) => Reply;
  doctor?: Reply;
  version?: (installed: string) => Reply;
  status?: Reply;
  start?: Reply;
  npmVersion?: Reply;
}) {
  let installed = opts.installed ?? '0.9.0';
  const calls: string[] = [];
  const exec: ApplyExec = vi.fn(async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(' '));
    const r = (x: Reply) => ({ code: x.code, stdout: x.stdout ?? '', stderr: x.stderr ?? '' });
    if (cmd === NPM && args[0] === '--version') return r(opts.npmVersion ?? { code: 0, stdout: '11.0.0\n' });
    if (cmd === NPM && args[0] === 'i') {
      const spec = args.at(-1)!;
      const res = opts.install?.(spec) ?? { code: 0 };
      if (res.code === 0) installed = spec.split('@').at(-1)!;
      return r(res);
    }
    if (cmd === NODE && args[1] === '--version')
      return r(opts.version?.(installed) ?? { code: 0, stdout: `${installed}\n` });
    if (cmd === NODE && args[1] === 'doctor') return r(opts.doctor ?? { code: 0 });
    if (cmd === NODE && args[1] === 'daemon' && args[2] === 'status')
      return r(opts.status ?? { code: 0, stdout: '{"running":false}' });
    if (cmd === NODE && args[1] === 'daemon' && args[2] === 'start') return r(opts.start ?? { code: 0 });
    return r({ code: 127, stderr: `unexpected ${cmd}` });
  });
  return { exec, calls, installed: () => installed };
}

function deps(
  exec: ApplyExec,
  over: Partial<SelfUpdateApplyDeps> = {},
  env: NodeJS.ProcessEnv = {},
): SelfUpdateApplyDeps {
  return {
    exec,
    platform: 'darwin',
    activeRuns: async () => [],
    updateStateFile: null,
    install: { version: '0.9.0', env, execPath: NODE, cliPath: CLI, exists: () => false },
    ...over,
  };
}

const installCmd = (v: string) => `${NPM} i -g --prefix ${PREFIX} @on-par/factory-cli@${v}`;

describe('stableVersionError', () => {
  it.each(['0.9.1', 'v1.2.3', '10.0.0'])('accepts %s', (v) => expect(stableVersionError(v)).toBeNull());
  it.each(['0.9.1-next.0', '1.0.0-rc.1'])('rejects prerelease %s', (v) =>
    expect(stableVersionError(v)).toContain('prerelease'),
  );
  it.each(['latest', '0.9', '^0.9.1', '0.9.1 || 1.0.0', '', '0.9.1+build.5'])('rejects invalid %j', (v) =>
    expect(stableVersionError(v)).toMatch(/invalid version/),
  );
});

describe('applySelfUpdate', () => {
  it('happy path: prefixed install, version check, doctor, restart of a running factoryd', async () => {
    const s = stubExec({ status: { code: 0, stdout: '{"running":true}' } });
    const { code, result } = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec));
    expect(code).toBe(0);
    expect(s.calls).toEqual([
      installCmd('0.9.1'),
      `${NODE} ${CLI} --version`,
      `${NODE} ${CLI} doctor`,
      `${NODE} ${CLI} daemon status --json`,
      `${NODE} ${CLI} daemon start`,
    ]);
    expect(result).toMatchObject({
      outcome: 'updated',
      from: '0.9.0',
      to: '0.9.1',
      rolledBack: false,
      restart: 'restarted',
      error: null,
    });
    expect(s.installed()).toBe('0.9.1');
  });

  it('--no-restart (factoryd) leaves the restart to factoryd and never touches the daemon', async () => {
    const s = stubExec({});
    const { code, result } = await applySelfUpdate({ to: '0.9.1', restart: false }, deps(s.exec));
    expect(code).toBe(0);
    expect(result.restart).toBe('factoryd');
    expect(s.calls.some((c) => c.includes('daemon'))).toBe(false);
  });

  it('reports not-running off macOS or when factoryd is down, and a failed restart without rolling back', async () => {
    const linux = await applySelfUpdate({ to: '0.9.1' }, deps(stubExec({}).exec, { platform: 'linux' }));
    expect(linux.result.restart).toBe('not-running');
    const down = await applySelfUpdate({ to: '0.9.1' }, deps(stubExec({ status: { code: 1, stdout: 'nope' } }).exec));
    expect(down.result.restart).toBe('not-running');
    const s = stubExec({
      status: { code: 0, stdout: '{"running":true}' },
      start: { code: 1, stderr: 'launchctl boom' },
    });
    const failed = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec));
    expect(failed.code).toBe(0);
    expect(failed.result).toMatchObject({ outcome: 'updated', restart: 'failed', rolledBack: false });
    expect(formatApplyResult(failed.result)).toContain('factory daemon start');
  });

  it('includes the restart step detail in the text output when the factoryd restart fails', async () => {
    const s = stubExec({
      status: { code: 0, stdout: '{"running":true}' },
      start: { code: 1, stderr: 'factory: launchctl bootstrap failed: Bootstrap failed: 5: Input/output error' },
    });
    const { result } = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec));
    const text = formatApplyResult(result);
    expect(text).toContain('Bootstrap failed: 5: Input/output error');
    expect(text).toContain('factory daemon start');
  });

  it('doctor fails → reinstalls the previous exact version with the same prefix and exits 1', async () => {
    const s = stubExec({ doctor: { code: 1, stderr: 'claude: not signed in' } });
    const { code, result } = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec));
    expect(code).toBe(1);
    expect(s.calls).toContain(installCmd('0.9.0'));
    expect(s.installed()).toBe('0.9.0');
    expect(result).toMatchObject({ outcome: 'rolled-back', rolledBack: true, restart: null });
    expect(result.error).toContain('doctor failed on 0.9.1: exit 1');
    expect(s.calls.some((c) => c.includes('daemon'))).toBe(false);
  });

  const FOOTER = ['', 'Model reachability: factory models --doctor'];
  it('doctor rollback names the failing check, not the Model reachability footer', async () => {
    const stdout = [
      '== factory doctor ==',
      '  ✅ node - v22',
      '  ❌ git auth - not authenticated',
      '       fix: gh auth login',
      '1 passed, 1 failed, 0 warnings',
      ...FOOTER,
    ].join('\n');
    const s = stubExec({ doctor: { code: 1, stdout } });
    const { result } = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec));
    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toContain('git auth');
    expect(result.error).not.toContain('Model reachability');
  });

  it('doctor rollback names every failing check', async () => {
    const stdout = [
      '  ❌ git auth - not authenticated',
      '  ⚠️ optional thing - meh',
      '  ❌ claude auth - signed out',
      ...FOOTER,
    ].join('\n');
    const s = stubExec({ doctor: { code: 1, stdout } });
    const { result } = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec));
    expect(result.error).toContain('failing checks: git auth, claude auth');
    expect(result.error).not.toContain('optional thing');
  });

  it('doctor rollback with no failing row falls back to the exit code', async () => {
    const stdout = ['  ✅ node - v22', '  ⚠️ optional thing - meh', ...FOOTER].join('\n');
    const s = stubExec({ doctor: { code: 2, stdout } });
    const { result } = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec));
    expect(result.error).toBe('doctor failed on 0.9.1: exit 2');
  });

  it('failingDoctorChecks strips ANSI, dedupes, and handles empty input', () => {
    expect(failingDoctorChecks('\u001b[31m  ❌ git auth - bad\u001b[0m')).toEqual(['git auth']);
    expect(failingDoctorChecks('  ❌ a - x\n  ❌ a - y')).toEqual(['a']);
    expect(failingDoctorChecks('')).toEqual([]);
  });

  it('install fails → previous version stays in place and it exits 1', async () => {
    const s = stubExec({
      install: (spec) => (spec.endsWith('0.9.1') ? { code: 1, stderr: 'npm ERR! 404' } : { code: 0 }),
    });
    const { code, result } = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec));
    expect(code).toBe(1);
    expect(s.installed()).toBe('0.9.0');
    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toContain('npm ERR! 404');
  });

  it('version mismatch after install → rolls back', async () => {
    const s = stubExec({ version: (v) => ({ code: 0, stdout: v === '0.9.1' ? '0.8.0\n' : `${v}\n` }) });
    const { code, result } = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec));
    expect(code).toBe(1);
    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toContain('expected 0.9.1, got 0.8.0');
  });

  it('a failed rollback is reported as failed, not rolled-back', async () => {
    const s = stubExec({
      doctor: { code: 1 },
      install: (spec) => (spec.endsWith('0.9.0') ? { code: 1 } : { code: 0 }),
    });
    const { code, result } = await applySelfUpdate({ to: '0.9.1', json: true }, deps(s.exec));
    expect(code).toBe(1);
    expect(result).toMatchObject({ outcome: 'failed', rolledBack: false });
    expect(result.error).toContain('rollback to 0.9.0 also failed');
  });

  it.each(['0.9.1-next.0', 'latest', '0.9'])('refuses %s with exit 2 and runs no npm command', async (to) => {
    const s = stubExec({});
    const { code, result } = await applySelfUpdate({ to }, deps(s.exec));
    expect(code).toBe(2);
    expect(result.outcome).toBe('refused');
    expect(s.calls).toEqual([]);
  });

  it('refuses a source install (FACTORY_FROM_SOURCE=1) with exit 2 and no npm command', async () => {
    const s = stubExec({});
    const { code, result } = await applySelfUpdate({ to: '0.9.1' }, deps(s.exec, {}, { FACTORY_FROM_SOURCE: '1' }));
    expect(code).toBe(2);
    expect(result.error).toContain('source install');
    expect(s.calls).toEqual([]);
  });

  it('refuses with exit 3 while a run is active, unless --force', async () => {
    const s = stubExec({});
    const busy = deps(s.exec, { activeRuns: async () => ['acme/app'] });
    const r = await applySelfUpdate({ to: '0.9.1' }, busy);
    expect(r.code).toBe(3);
    expect(r.result.outcome).toBe('busy');
    expect(s.calls).toEqual([]);
    expect((await applySelfUpdate({ to: '0.9.1', force: true }, busy)).code).toBe(0);
  });

  it('--dry-run validates and probes npm without installing', async () => {
    const s = stubExec({});
    const { code, result } = await applySelfUpdate({ to: 'v0.9.1', dryRun: true }, deps(s.exec));
    expect(code).toBe(0);
    expect(result).toMatchObject({ outcome: 'dry-run', to: '0.9.1', dryRun: true });
    expect(s.calls).toEqual([`${NPM} --version`]);
    const bad = await applySelfUpdate(
      { to: '0.9.1', dryRun: true },
      deps(stubExec({ npmVersion: { code: 127 } }).exec),
    );
    expect(bad.code).toBe(1);
    expect(bad.result.error).toContain('npm not runnable');
  });

  it('is a no-op when already on the target version', async () => {
    const s = stubExec({});
    const { code, result } = await applySelfUpdate({ to: '0.9.0' }, deps(s.exec));
    expect(code).toBe(0);
    expect(result.outcome).toBe('up-to-date');
    expect(s.calls).toEqual([]);
  });

  it('cmdSelfUpdateApply prints one JSON line with --json and text otherwise', async () => {
    const out: string[] = [];
    const s = stubExec({});
    const code = await cmdSelfUpdateApply(
      { to: '0.9.1', json: true, restart: false },
      { ...deps(s.exec), out: { write: (x: string) => out.push(x) } },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ outcome: 'updated', to: '0.9.1', restart: 'factoryd' });
    const text: string[] = [];
    await cmdSelfUpdateApply({ to: '0.9.1-next.0' }, { ...deps(s.exec), out: { write: (x: string) => text.push(x) } });
    expect(text.join('')).toContain('refused');
  });

  it('formats every outcome', async () => {
    const s = stubExec({});
    for (const [opts, re] of [
      [{ to: '0.9.0' }, /already/],
      [{ to: '0.9.1', dryRun: true }, /preflight ok/],
      [{ to: '0.9.1', restart: false }, /updated 0\.9\.0 → 0\.9\.1$/],
    ] as const) {
      expect(formatApplyResult((await applySelfUpdate(opts, deps(s.exec))).result)).toMatch(re);
    }
    const rb = await applySelfUpdate({ to: '0.9.1' }, deps(stubExec({ doctor: { code: 1 } }).exec));
    expect(formatApplyResult(rb.result)).toContain('rolled back to 0.9.0');
  });
});

describe('cmdSelfUpdateApply records its outcome in update-state lastResult (#2933)', () => {
  let dir: string;
  let file: string;
  const NOW = new Date('2026-10-14T00:00:00.000Z');
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'self-update-record-'));
    file = join(dir, 'update-state.json');
    writeUpdateState(file, {
      schemaVersion: 1,
      mode: 'stable',
      channel: 'latest',
      installKind: 'npm-global',
      current: '0.9.0',
      available: '0.9.1',
      lastCheckAt: null,
      lastResult: {
        at: '2026-10-01T00:00:00.000Z',
        version: '0.9.0',
        outcome: 'failed',
        error: "unknown option '--to'",
      },
      draining: null,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (
    exec: ApplyExec,
    opts: { to: string; dryRun?: boolean; restart?: boolean } = { to: '0.9.1' },
    path = file,
  ) => cmdSelfUpdateApply(opts, deps(exec, { updateStateFile: path, now: () => NOW, out: { write: () => true } }));

  it('records updated over an older failure, and the status line no longer shows it', async () => {
    expect(await run(stubExec({}).exec)).toBe(0);
    const st = readUpdateState(file)!;
    expect(st.lastResult).toEqual({ at: NOW.toISOString(), version: '0.9.1', outcome: 'updated' });
    expect(st.current).toBe('0.9.1');
    expect(st.available).toBeNull();
    const line = formatUpdateStatusLine(buildStatusUpdateJson(st));
    expect(line).toContain('last update to 0.9.1 updated');
    expect(line).not.toContain('unknown option');
  });

  it('records rolled-back with the target version and the error', async () => {
    const out = { write: vi.fn() };
    const e = stubExec({ doctor: { code: 1 } });
    expect(
      await cmdSelfUpdateApply(
        { to: '0.9.1', json: true },
        deps(e.exec, { updateStateFile: file, now: () => NOW, out }),
      ),
    ).toBe(1);
    const reported = JSON.parse(String(out.write.mock.calls[0]![0])) as { error: string };
    const last = readUpdateState(file)!.lastResult!;
    expect(last).toMatchObject({ outcome: 'rolled-back', version: '0.9.1', error: reported.error });
    expect(last.error).toContain('doctor failed on 0.9.1');
  });

  it('records failed when the rollback also fails', async () => {
    const s = stubExec({
      doctor: { code: 1 },
      install: (spec) => (spec.endsWith('0.9.0') ? { code: 1 } : { code: 0 }),
    });
    expect(await run(s.exec)).toBe(1);
    const last = readUpdateState(file)!.lastResult!;
    expect(last).toMatchObject({ outcome: 'failed', version: '0.9.1' });
    expect(last.error).toContain('rollback to 0.9.0 also failed');
  });

  it('leaves the file unchanged for refused, dry-run, up-to-date and --no-restart runs', async () => {
    const before = readFileSync(file, 'utf8');
    expect(await run(stubExec({}).exec, { to: 'latest' })).toBe(2);
    expect(await run(stubExec({}).exec, { to: '0.9.1', dryRun: true })).toBe(0);
    expect(await run(stubExec({}).exec, { to: '0.9.0' })).toBe(0);
    expect(await run(stubExec({}).exec, { to: '0.9.1', restart: false })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not create a missing file', async () => {
    const missing = join(dir, 'nope', 'update-state.json');
    expect(await run(stubExec({}).exec, { to: '0.9.1' }, missing)).toBe(0);
    expect(existsSync(missing)).toBe(false);
  });
});

describe('factory self-update option parsing (#2355)', () => {
  async function parse(args: string[], selfUpdate: SelfUpdateApplyDeps) {
    const program = new Command().exitOverride();
    const partial: Partial<ProgramHandlers> = { CliExitError, cmdSelfUpdateCheck: vi.fn(async () => 0) };
    const handlers = partial as ProgramHandlers;
    registerAdvancedCommands(program, handlers, { selfUpdate } as CliDeps);
    process.exitCode = undefined;
    try {
      await program.parseAsync(['node', 'factory', 'self-update', ...args]);
    } catch (err) {
      if (err instanceof CliExitError) return { code: err.code, handlers };
      throw err;
    }
    const code = process.exitCode as number | undefined;
    process.exitCode = undefined;
    return { code: code ?? 0, handlers };
  }

  it('--to <v> --no-restart --json runs the apply flow with a prefixed install', async () => {
    const s = stubExec({});
    const out: string[] = [];
    const r = await parse(['--to', '0.9.1', '--no-restart', '--json'], {
      ...deps(s.exec),
      out: { write: (x: string) => out.push(x) },
    });
    expect(r.code).toBe(0);
    expect(s.calls[0]).toBe(installCmd('0.9.1'));
    expect(JSON.parse(out.join(''))).toMatchObject({ outcome: 'updated', restart: 'factoryd' });
  });

  it('--to --dry-run --force probes npm only, even with an active run', async () => {
    const s = stubExec({});
    const r = await parse(['--to', '0.9.1', '--dry-run', '--force', '--json'], {
      ...deps(s.exec, { activeRuns: async () => ['acme/app'] }),
      out: { write: () => {} },
    });
    expect(r.code).toBe(0);
    expect(s.calls).toEqual([`${NPM} --version`]);
  });

  it('a prerelease --to exits 2; --check with --to exits 2; no flag exits 2; --check still dispatches', async () => {
    const quiet = { ...deps(stubExec({}).exec), out: { write: () => {} } };
    expect((await parse(['--to', '0.9.1-next.0', '--json'], quiet)).code).toBe(2);
    expect((await parse(['--check', '--to', '0.9.1'], quiet)).code).toBe(2);
    expect((await parse([], quiet)).code).toBe(2);
    const check = await parse(['--check'], quiet);
    expect(check.handlers.cmdSelfUpdateCheck).toHaveBeenCalledOnce();
  });
});

describe('production seams', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'self-update-apply-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('attachedRunLocks lists attached repos with a live run lock and skips detached ones', async () => {
    const live = join(dir, 'live');
    const gone = join(dir, 'gone');
    const idle = join(dir, 'idle');
    for (const repo of [live, gone]) {
      const lock = getFactoryPaths(repo).runLock;
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'pid'), String(process.pid));
    }
    mkdirSync(idle);
    const registryFile = join(dir, 'registry.json');
    writeFileSync(
      registryFile,
      JSON.stringify({
        version: 1,
        repos: {
          'acme/live': { path: live, attachedAt: 'x', state: 'active' },
          'acme/gone': { path: gone, attachedAt: 'x', state: 'detached' },
          'acme/idle': { path: idle, attachedAt: 'x', state: 'active' },
        },
      }),
    );
    expect(await attachedRunLocks(registryFile)).toEqual(['acme/live']);
  });

  it('the default exec runs the sibling npm for --dry-run and maps a missing binary to exit 1', async () => {
    const prefix = join(dir, 'prefix');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    const install = {
      version: '0.9.0',
      env: {},
      execPath: join(prefix, 'bin', 'node'),
      cliPath: join(prefix, 'lib', 'node_modules', '@on-par', 'factory-cli', 'dist', 'cli.js'),
      exists: () => false,
    };
    const opts = { to: '0.9.1', dryRun: true, force: true };
    const missing = await applySelfUpdate(opts, { install });
    expect(missing.code).toBe(1);
    expect(missing.result.steps[0]).toMatchObject({ step: 'preflight', ok: false, code: 1 });
    const npm = join(prefix, 'bin', 'npm');
    writeFileSync(npm, '#!/bin/sh\necho 11.0.0\n');
    chmodSync(npm, 0o755);
    expect((await applySelfUpdate(opts, { install })).code).toBe(0);
    writeFileSync(npm, '#!/bin/sh\necho nope >&2\nexit 7\n');
    const failed = await applySelfUpdate(opts, { install });
    expect(failed.result.steps[0]).toMatchObject({ code: 7, detail: 'nope' });
  });
});
