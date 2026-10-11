// packages/cli/src/cli/daemon.test.ts — factory daemon start|stop|status|logs (#1179).

import { mkdtempSync, appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';

import {
  createFactorydServer,
  DEFAULT_FACTORYD_PORT,
  defaultRegistryPath,
  listRepos,
  loadRegistry,
} from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cmdDaemonAttach,
  cmdDaemonDetach,
  cmdDaemonLogs,
  cmdDaemonStart,
  cmdDaemonStatus,
  cmdDaemonStop,
  DaemonCtlError,
  defaultExec,
  FACTORYD_LABEL,
  factorydFiles,
  lastLines,
  parseEtime,
  parseLaunchctlPid,
  renderFactorydPlist,
  resolveFactorydConfig,
  resolveFactorydPort,
} from './daemon.js';
import type { DaemonCtlDeps, LaunchctlExec } from './daemon.js';

interface ExecCall {
  cmd: string;
  args: string[];
}

/** Records calls and returns scripted results keyed by the launchctl/ps subcommand. */
function makeFakeExec(results: Record<string, { code: number; stdout?: string; stderr?: string }> = {}): {
  exec: LaunchctlExec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: LaunchctlExec = (cmd, args) => {
    calls.push({ cmd, args });
    const key = cmd === 'ps' ? 'ps' : (args[0] ?? '');
    const r = results[key] ?? { code: 0 };
    return Promise.resolve({ code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  };
  return { exec, calls };
}

function makeOut(): { out: { write(s: string): unknown }; text: () => string } {
  let buf = '';
  return {
    out: {
      write(s: string) {
        buf += s;
        return true;
      },
    },
    text: () => buf,
  };
}

const PRINT_RUNNING = [
  'system/com.onpar.factoryd = {',
  '\tactive count = 1',
  '\tpath = /Users/op/Library/LaunchAgents/com.onpar.factoryd.plist',
  '\tstate = running',
  '\tpid = 123',
  '\tprogram = /usr/local/bin/node',
  '}',
].join('\n');

describe('factorydFiles', () => {
  it('derives the LaunchAgents dir, plist path, and log path from home', () => {
    expect(factorydFiles('/Users/op')).toEqual({
      launchAgentsDir: join('/Users/op', 'Library', 'LaunchAgents'),
      plistPath: join('/Users/op', 'Library', 'LaunchAgents', 'com.onpar.factoryd.plist'),
      logPath: join('/Users/op', '.factory', 'daemon.log'),
    });
  });
});

describe('resolveFactorydConfig', () => {
  const registry = '/tmp/r.json';

  it('defaults auto-update to off', () => {
    expect(resolveFactorydConfig({ registry })).toEqual({
      registryFile: registry,
      port: DEFAULT_FACTORYD_PORT,
      autoUpdate: false,
    });
    expect(resolveFactorydConfig({ registry, autoUpdate: undefined }).autoUpdate).toBe(false);
    expect(resolveFactorydConfig({ registry, autoUpdate: false }).autoUpdate).toBe(false);
  });

  it('opts in with autoUpdate: true and changes nothing else', () => {
    expect(resolveFactorydConfig({ registry, autoUpdate: true })).toEqual({
      registryFile: registry,
      port: DEFAULT_FACTORYD_PORT,
      autoUpdate: true,
    });
  });

  it('accepts the port bounds', () => {
    expect(resolveFactorydConfig({ registry, port: '0' }).port).toBe(0);
    expect(resolveFactorydConfig({ registry, port: '65535' }).port).toBe(65535);
  });

  it.each(['abc', '-1', '65536', '1.5'])('rejects invalid port %s with code 2', (port) => {
    let caught: unknown;
    try {
      resolveFactorydConfig({ registry, port });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DaemonCtlError);
    expect((caught as DaemonCtlError).code).toBe(2);
    expect((caught as DaemonCtlError).message).toBe(`invalid --port "${port}" — expected an integer 0-65535`);
  });

  it('falls back to the default registry path', () => {
    expect(resolveFactorydConfig({}).registryFile).toBe(defaultRegistryPath());
  });
});

describe('renderFactorydPlist', () => {
  const plist = renderFactorydPlist({
    nodePath: '/usr/local/bin/node',
    cliScriptPath: '/opt/factory/dist/cli/index.js',
    logPath: '/Users/op/.factory/daemon.log',
  });

  it('declares the label, KeepAlive, and RunAtLoad', () => {
    expect(plist).toContain(`<string>${FACTORYD_LABEL}</string>`);
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
  });

  it('runs node + cli script + the daemon run command, in order', () => {
    const args = /<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? '';
    const strings = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(strings).toEqual(['/usr/local/bin/node', '/opt/factory/dist/cli/index.js', 'daemon', 'run']);
  });

  it('sends stdout and stderr to the daemon log', () => {
    expect(plist).toContain('<key>StandardOutPath</key>\n  <string>/Users/op/.factory/daemon.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key>\n  <string>/Users/op/.factory/daemon.log</string>');
  });

  it('XML-escapes interpolated paths', () => {
    const escaped = renderFactorydPlist({
      nodePath: '/tmp/a&b/node',
      cliScriptPath: '/tmp/<x>/cli.js',
      logPath: '/tmp/log',
    });
    expect(escaped).toContain('<string>/tmp/a&amp;b/node</string>');
    expect(escaped).toContain('<string>/tmp/&lt;x&gt;/cli.js</string>');
    expect(escaped).not.toContain('a&b');
  });
});

describe('parseLaunchctlPid', () => {
  it('extracts the pid from a launchctl print blob', () => {
    expect(parseLaunchctlPid(PRINT_RUNNING)).toBe(123);
  });

  it('returns null when no pid line exists', () => {
    expect(parseLaunchctlPid('state = not running\nactive count = 0')).toBeNull();
  });
});

describe('lastLines', () => {
  it('returns the last n lines, ignoring a trailing newline', () => {
    expect(lastLines('a\nb\nc\nd\ne\n', 2)).toEqual(['d', 'e']);
  });

  it('returns everything when fewer than n lines', () => {
    expect(lastLines('a\nb', 5)).toEqual(['a', 'b']);
  });
});

describe('defaultExec', () => {
  const exec = defaultExec();

  it('resolves code 0 with stdout on success', async () => {
    const r = await exec(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(r).toEqual({ code: 0, stdout: 'hi', stderr: '' });
  });

  it('resolves the non-zero exit code instead of rejecting', async () => {
    const r = await exec(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)']);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('bad');
  });

  it('resolves code 1 when the binary does not exist', async () => {
    const r = await exec(join(tmpdir(), 'no-such-binary-for-factory-daemon-test'), []);
    expect(r.code).toBe(1);
  });
});

describe('daemon control commands', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'factory-daemon-test-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  function baseDeps(exec: LaunchctlExec, out: { write(s: string): unknown }): DaemonCtlDeps {
    return {
      exec,
      out,
      home,
      uid: 501,
      platform: 'darwin',
      nodePath: '/usr/local/bin/node',
      cliScriptPath: '/opt/factory/dist/cli/index.js',
      registryFile: join(home, '.factory', 'registry.json'),
    };
  }

  describe('cmdDaemonStart', () => {
    it('writes the plist, creates .factory, and runs bootout → bootstrap → print against gui/<uid>', async () => {
      const { exec, calls } = makeFakeExec({ print: { code: 0, stdout: PRINT_RUNNING } });
      const { out, text } = makeOut();
      await cmdDaemonStart(baseDeps(exec, out));

      const { plistPath } = factorydFiles(home);
      expect(existsSync(plistPath)).toBe(true);
      expect(existsSync(join(home, '.factory'))).toBe(true);
      expect(readFileSync(plistPath, 'utf-8')).toContain('<key>KeepAlive</key>');

      expect(calls).toEqual([
        { cmd: 'launchctl', args: ['bootout', 'gui/501/com.onpar.factoryd'] },
        { cmd: 'launchctl', args: ['bootstrap', 'gui/501', plistPath] },
        { cmd: 'launchctl', args: ['print', 'gui/501/com.onpar.factoryd'] },
      ]);
      expect(text()).toContain(`factoryd: installed ${plistPath}`);
      expect(text()).toContain('factoryd: running (pid 123)');
    });

    it('a bootout failure alone does not fail start', async () => {
      const { exec } = makeFakeExec({
        bootout: { code: 3, stderr: 'Boot-out failed: 3: No such process' },
        print: { code: 0, stdout: 'state = waiting' },
      });
      const { out, text } = makeOut();
      await cmdDaemonStart(baseDeps(exec, out));
      expect(text()).toContain('factoryd: loaded — launchd will start it (RunAtLoad)');
    });

    it('throws DaemonCtlError(1) with stderr text when bootstrap fails', async () => {
      const { exec } = makeFakeExec({ bootstrap: { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } });
      const { out } = makeOut();
      const err = await cmdDaemonStart(baseDeps(exec, out)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonCtlError);
      expect((err as DaemonCtlError).code).toBe(1);
      expect((err as DaemonCtlError).message).toContain('Bootstrap failed: 5');
    });
  });

  describe('cmdDaemonStop', () => {
    it('reports stopped when bootout succeeds', async () => {
      const { exec, calls } = makeFakeExec({ bootout: { code: 0 } });
      const { out, text } = makeOut();
      await cmdDaemonStop(baseDeps(exec, out));
      expect(calls).toEqual([{ cmd: 'launchctl', args: ['bootout', 'gui/501/com.onpar.factoryd'] }]);
      expect(text()).toContain('factoryd: stopped (unloaded from launchd)');
      expect(text()).toContain('plist stays installed');
    });

    it('is idempotent: a not-loaded agent is already stopped, not an error', async () => {
      const { exec } = makeFakeExec({ bootout: { code: 3 } });
      const { out, text } = makeOut();
      await cmdDaemonStop(baseDeps(exec, out));
      expect(text()).toContain('factoryd: not loaded — already stopped');
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('parseEtime', () => {
    it.each([
      ['01:02', 62],
      ['02:03:04', 7384],
      ['02-11:22:33', 213753],
      ['  05:00\n', 300],
    ])('parses %j as %d seconds', (input, secs) => {
      expect(parseEtime(input)).toBe(secs);
    });

    it.each(['', 'abc', '1:2:3:4', '1-02:03'])('returns null for %j', (input) => {
      expect(parseEtime(input)).toBeNull();
    });
  });

  describe('cmdDaemonStatus', () => {
    describe('--json', () => {
      it('running with a populated registry prints one JSON object', async () => {
        const { exec, calls } = makeFakeExec({
          print: { code: 0, stdout: PRINT_RUNNING.replace('pid = 123', 'pid = 42') },
          ps: { code: 0, stdout: '   02-11:22:33\n' },
        });
        const { out, text } = makeOut();
        const registryFile = join(home, '.factory', 'registry.json');
        mkdirSync(join(home, '.factory'), { recursive: true });
        writeFileSync(
          registryFile,
          JSON.stringify({
            version: 1,
            repos: {
              'on-par/software-factory': { path: '/tmp/sf', attachedAt: '2026-01-01T00:00:00.000Z', state: 'active' },
              'on-par/other': { path: '/tmp/other', attachedAt: '2026-01-01T00:00:00.000Z', state: 'paused' },
            },
          }),
        );

        await cmdDaemonStatus({ ...baseDeps(exec, out), registryFile }, { json: true });
        expect(text().endsWith('\n')).toBe(true);
        expect(text().split('\n')).toHaveLength(2);
        expect(JSON.parse(text())).toEqual({
          schemaVersion: 1,
          running: true,
          pid: 42,
          uptimeSec: 213753,
          plistInstalled: false,
          repos: [
            { slug: 'on-par/other', checkoutPath: '/tmp/other', state: 'paused' },
            { slug: 'on-par/software-factory', checkoutPath: '/tmp/sf', state: 'active' },
          ],
        });
        expect(process.exitCode).toBeUndefined();
        expect(calls.map((c) => c.cmd)).toEqual(['launchctl', 'ps']);
        expect(calls[1]).toEqual({ cmd: 'ps', args: ['-o', 'etime=', '-p', '42'] });
      });

      it('not loaded → running false, exit 1, only the print call', async () => {
        const { exec, calls } = makeFakeExec({ print: { code: 113 } });
        const { out, text } = makeOut();
        await cmdDaemonStatus(baseDeps(exec, out), { json: true });
        expect(JSON.parse(text())).toMatchObject({ running: false, pid: null, uptimeSec: null, repos: [] });
        expect(process.exitCode).toBe(1);
        expect(calls).toHaveLength(1);
      });

      it('loaded but not running → running false, exit 1, no ps call', async () => {
        const { exec, calls } = makeFakeExec({ print: { code: 0, stdout: 'state = waiting' } });
        const { out, text } = makeOut();
        await cmdDaemonStatus(baseDeps(exec, out), { json: true });
        expect(JSON.parse(text())).toMatchObject({ running: false, pid: null, uptimeSec: null });
        expect(process.exitCode).toBe(1);
        expect(calls.map((c) => c.cmd)).toEqual(['launchctl']);
      });

      it('missing registry file → repos []', async () => {
        const { exec } = makeFakeExec({ print: { code: 113 } });
        const { out, text } = makeOut();
        await cmdDaemonStatus(baseDeps(exec, out), { json: true });
        expect(JSON.parse(text()).repos).toEqual([]);
      });

      it('plist present on disk → plistInstalled true', async () => {
        const { exec } = makeFakeExec({ print: { code: 113 } });
        const { out, text } = makeOut();
        const { launchAgentsDir, plistPath } = factorydFiles(home);
        mkdirSync(launchAgentsDir, { recursive: true });
        writeFileSync(plistPath, 'x');
        await cmdDaemonStatus(baseDeps(exec, out), { json: true });
        expect(JSON.parse(text()).plistInstalled).toBe(true);
      });

      it('ps prints nothing → running true with null uptimeSec', async () => {
        const { exec } = makeFakeExec({
          print: { code: 0, stdout: PRINT_RUNNING },
          ps: { code: 1, stdout: '' },
        });
        const { out, text } = makeOut();
        await cmdDaemonStatus(baseDeps(exec, out), { json: true });
        expect(JSON.parse(text())).toMatchObject({ running: true, uptimeSec: null });
      });
    });

    it('reports pid + uptime via ps and lists attached repos from the registry', async () => {
      const { exec, calls } = makeFakeExec({
        print: { code: 0, stdout: PRINT_RUNNING.replace('pid = 123', 'pid = 42') },
        ps: { code: 0, stdout: '   02-11:22:33\n' },
      });
      const { out, text } = makeOut();
      const registryFile = join(home, '.factory', 'registry.json');
      mkdirSync(join(home, '.factory'), { recursive: true });
      writeFileSync(
        registryFile,
        JSON.stringify({
          version: 1,
          repos: {
            'on-par/software-factory': { path: '/tmp/sf', attachedAt: '2026-01-01T00:00:00.000Z', state: 'active' },
            'on-par/other': { path: '/tmp/other', attachedAt: '2026-01-01T00:00:00.000Z', state: 'paused' },
          },
        }),
      );

      await cmdDaemonStatus({ ...baseDeps(exec, out), registryFile });
      expect(calls[1]).toEqual({ cmd: 'ps', args: ['-o', 'etime=', '-p', '42'] });
      expect(text()).toContain('factoryd: running (pid 42, uptime 02-11:22:33)');
      expect(text()).toContain('attached repos (2):');
      expect(text()).toContain('on-par/other [paused]');
      expect(text()).toContain('on-par/software-factory [active]');
      expect(process.exitCode).toBeUndefined();
    });

    it('not loaded → exit code 1, plist state, start hint, and repos still listed', async () => {
      const { exec } = makeFakeExec({ print: { code: 113, stderr: 'Could not find service' } });
      const { out, text } = makeOut();
      await cmdDaemonStatus(baseDeps(exec, out));
      expect(text()).toContain('factoryd: not loaded');
      expect(text()).toContain('plist not installed');
      expect(text()).toContain('run: factory daemon start');
      expect(text()).toContain('attached repos: none');
      expect(process.exitCode).toBe(1);
    });

    it('loaded but not running → exit code 1', async () => {
      const { exec } = makeFakeExec({ print: { code: 0, stdout: 'state = waiting\nactive count = 0' } });
      const { out, text } = makeOut();
      await cmdDaemonStatus(baseDeps(exec, out));
      expect(text()).toContain('factoryd: loaded (not currently running)');
      expect(process.exitCode).toBe(1);
    });

    it('reports the plist as installed when present on disk', async () => {
      const { exec } = makeFakeExec({ print: { code: 113 } });
      const { out, text } = makeOut();
      const { launchAgentsDir, plistPath } = factorydFiles(home);
      mkdirSync(launchAgentsDir, { recursive: true });
      writeFileSync(plistPath, 'x');
      await cmdDaemonStatus(baseDeps(exec, out));
      expect(text()).toContain(`plist installed: ${plistPath}`);
    });

    it('falls back to unknown uptime when ps prints nothing', async () => {
      const { exec } = makeFakeExec({
        print: { code: 0, stdout: PRINT_RUNNING },
        ps: { code: 1, stdout: '' },
      });
      const { out, text } = makeOut();
      await cmdDaemonStatus(baseDeps(exec, out));
      expect(text()).toContain('factoryd: running (pid 123, uptime unknown)');
    });
  });

  describe('cmdDaemonLogs', () => {
    it('a missing log file is a friendly message, not a crash', async () => {
      const { out, text } = makeOut();
      await cmdDaemonLogs({}, { home, out });
      expect(text()).toContain('no daemon log yet at');
      expect(text()).toContain('is the daemon started?');
    });

    it('prints only the last N lines', async () => {
      const { logPath } = factorydFiles(home);
      mkdirSync(join(home, '.factory'), { recursive: true });
      writeFileSync(logPath, 'one\ntwo\nthree\nfour\nfive\n');
      const { out, text } = makeOut();
      await cmdDaemonLogs({ lines: '2' }, { home, out });
      expect(text()).toBe('four\nfive\n');
    });

    it('rejects a non-numeric --lines with code 2', async () => {
      const { out } = makeOut();
      const err = await cmdDaemonLogs({ lines: 'abc' }, { home, out }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonCtlError);
      expect((err as DaemonCtlError).code).toBe(2);
    });

    it('follow mode streams bytes appended after start until SIGINT', async () => {
      const { logPath } = factorydFiles(home);
      mkdirSync(join(home, '.factory'), { recursive: true });
      writeFileSync(logPath, 'first\n');
      const { out, text } = makeOut();

      const done = cmdDaemonLogs({ follow: true }, { home, out, pollMs: 10 });
      appendFileSync(logPath, 'second\n');
      while (!text().includes('second')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      process.emit('SIGINT');
      await done;
      expect(text()).toBe('first\nsecond\n');
    });

    it('follow mode stays quiet while the log has not grown', async () => {
      const { logPath } = factorydFiles(home);
      mkdirSync(join(home, '.factory'), { recursive: true });
      writeFileSync(logPath, 'first\n');
      const { out, text } = makeOut();

      const done = cmdDaemonLogs({ follow: true }, { home, out, pollMs: 10 });
      await new Promise((r) => setTimeout(r, 40));
      process.emit('SIGINT');
      await done;
      expect(text()).toBe('first\n');
    });

    it('follow mode keeps polling while the log file is transiently missing', async () => {
      const { logPath } = factorydFiles(home);
      mkdirSync(join(home, '.factory'), { recursive: true });
      writeFileSync(logPath, 'longer-initial-line\n');
      const { out, text } = makeOut();

      const done = cmdDaemonLogs({ follow: true }, { home, out, pollMs: 10 });
      rmSync(logPath);
      await new Promise((r) => setTimeout(r, 40)); // a few polls with no file
      writeFileSync(logPath, 'back\n');
      while (!text().includes('back')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      process.emit('SIGINT');
      await done;
      expect(text()).toContain('back');
    });

    it('follow mode resets to the start of a truncated (rotated) file', async () => {
      const { logPath } = factorydFiles(home);
      mkdirSync(join(home, '.factory'), { recursive: true });
      writeFileSync(logPath, 'old-line-that-is-long\n');
      const { out, text } = makeOut();

      const done = cmdDaemonLogs({ follow: true }, { home, out, pollMs: 10 });
      writeFileSync(logPath, 'fresh\n');
      while (!text().includes('fresh')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      process.emit('SIGINT');
      await done;
      expect(text()).toContain('fresh');
    });
  });

  describe('non-darwin gate', () => {
    it.each([
      ['start', () => cmdDaemonStart],
      ['stop', () => cmdDaemonStop],
      ['status', () => cmdDaemonStatus],
    ])('daemon %s throws DaemonCtlError(2) off macOS', async (_name, cmd) => {
      const { exec, calls } = makeFakeExec();
      const { out } = makeOut();
      const err = await cmd()({ ...baseDeps(exec, out), platform: 'linux' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonCtlError);
      expect((err as DaemonCtlError).code).toBe(2);
      expect((err as DaemonCtlError).message).toContain('requires macOS launchd');
      expect(calls).toEqual([]);
    });

    it('daemon status --json throws DaemonCtlError(2) off macOS with empty stdout', async () => {
      const { exec, calls } = makeFakeExec();
      const { out, text } = makeOut();
      const err = await cmdDaemonStatus({ ...baseDeps(exec, out), platform: 'linux' }, { json: true }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DaemonCtlError);
      expect((err as DaemonCtlError).code).toBe(2);
      expect(calls).toEqual([]);
      expect(text()).toBe('');
    });

    it('daemon logs still works off macOS (it only reads a file)', async () => {
      const { logPath } = factorydFiles(home);
      mkdirSync(join(home, '.factory'), { recursive: true });
      writeFileSync(logPath, 'hello\n');
      const { out, text } = makeOut();
      await cmdDaemonLogs({}, { home, out, platform: 'linux' });
      expect(text()).toBe('hello\n');
    });
  });
});

describe('resolveFactorydPort', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-port-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prefers the flag, then the port file, then the default', () => {
    const f = join(dir, 'daemon.port');
    writeFileSync(f, JSON.stringify({ port: 9001 }));
    expect(resolveFactorydPort('1234', f)).toBe(1234);
    expect(resolveFactorydPort(undefined, f)).toBe(9001);
  });

  it('falls back to the default for a missing, garbage or out-of-range port file', () => {
    const f = join(dir, 'daemon.port');
    expect(resolveFactorydPort(undefined, f)).toBe(DEFAULT_FACTORYD_PORT);
    writeFileSync(f, 'nope');
    expect(resolveFactorydPort(undefined, f)).toBe(DEFAULT_FACTORYD_PORT);
    writeFileSync(f, JSON.stringify({ port: 70000 }));
    expect(resolveFactorydPort(undefined, f)).toBe(DEFAULT_FACTORYD_PORT);
  });

  it.each(['abc', '-1', '70000', '1.5', ''])('rejects invalid flag %j with code 2', (v) => {
    expect(() => resolveFactorydPort(v, join(dir, 'x'))).toThrow(DaemonCtlError);
    try {
      resolveFactorydPort(v, join(dir, 'x'));
    } catch (e) {
      expect((e as DaemonCtlError).code).toBe(2);
    }
  });
});

describe('cmdDaemonAttach / cmdDaemonDetach', () => {
  let dir: string;
  let registryFile: string;
  let checkoutDir: string;
  let servers: Array<{ stop(): Promise<void> }> = [];
  const ORIGIN = 'git@github.com:acme/widget.git';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-attach-'));
    registryFile = join(dir, 'registry.json');
    checkoutDir = join(dir, 'checkout');
    mkdirSync(checkoutDir, { recursive: true });
  });
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    servers = [];
    rmSync(dir, { recursive: true, force: true });
  });

  async function startDaemon(fileExists = true): Promise<number> {
    const server = createFactorydServer({
      registryFile,
      port: 0,
      log: () => {},
      detachDeps: { pollIntervalMs: 5 },
      attachDeps: { readOrigin: async () => ORIGIN, fileExists: async () => fileExists },
    });
    servers.push(server);
    return server.start();
  }

  function deps(extra: DaemonCtlDeps = {}): { deps: DaemonCtlDeps; text: () => string; errText: () => string } {
    const o = makeOut();
    const e = makeOut();
    return {
      deps: { registryFile, stateDir: dir, readOrigin: async () => ORIGIN, out: o.out, err: e.out, ...extra },
      text: o.text,
      errText: e.text,
    };
  }

  function eventLines(): string[] {
    const f = join(checkoutDir, '.factory', 'state', 'events.ndjson');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n') : [];
  }

  async function rejection(p: Promise<void>): Promise<DaemonCtlError> {
    const e = await p.then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(DaemonCtlError);
    return e as DaemonCtlError;
  }

  /** A plain server answering every request with a fixed status/body. */
  async function stubServer(status: number, body?: string): Promise<number> {
    const srv = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    servers.push({ stop: () => new Promise<void>((r) => srv.close(() => r())) });
    return (srv.address() as { port: number }).port;
  }

  async function freePort(): Promise<number> {
    const srv = http.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    return port;
  }

  describe('cmdDaemonAttach', () => {
    it('attaches through a live factoryd and daemon status --json lists the repo', async () => {
      const port = await startDaemon();
      mkdirSync(join(checkoutDir, '.factory'), { recursive: true });
      const d = deps();
      await cmdDaemonAttach({ path: checkoutDir, port: String(port), json: true }, d.deps);
      expect(d.text()).toBe('{"schemaVersion":1,"ok":true,"action":"attach","repo":"acme/widget"}\n');

      const { exec } = makeFakeExec({ print: { code: 1 } });
      const status = makeOut();
      await cmdDaemonStatus({ platform: 'darwin', exec, registryFile, out: status.out, home: dir }, { json: true });
      expect(JSON.parse(status.text()).repos.map((r: { slug: string }) => r.slug)).toContain('acme/widget');
      const lines = eventLines();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string).type).toBe('repo-attached');
      process.exitCode = undefined;
    });

    it('prints the text success line and skips the event when the state root is missing', async () => {
      const port = await startDaemon();
      const d = deps();
      await cmdDaemonAttach({ path: checkoutDir, port: String(port) }, d.deps);
      expect(d.text()).toBe(`factoryd: attached acme/widget (${checkoutDir})\n`);
      expect(eventLines()).toEqual([]);
    });

    it('reports ok:false reason missing-factory-config with exit 1 and the detail on stderr', async () => {
      const port = await startDaemon(false);
      const d = deps();
      const err = await rejection(cmdDaemonAttach({ path: checkoutDir, port: String(port), json: true }, d.deps));
      expect(err.code).toBe(1);
      expect(err.message.length).toBeGreaterThan(0);
      expect(JSON.parse(d.text())).toEqual({
        schemaVersion: 1,
        ok: false,
        action: 'attach',
        repo: 'acme/widget',
        reason: 'missing-factory-config',
      });
      expect(existsSync(registryFile)).toBe(false);
    });

    it('prints nothing on stdout for a text-mode failure', async () => {
      const port = await startDaemon(false);
      const d = deps();
      await rejection(cmdDaemonAttach({ path: checkoutDir, port: String(port) }, d.deps));
      expect(d.text()).toBe('');
    });

    it('reports daemon-unreachable and throws DaemonCtlError code 1 when nothing listens on the port', async () => {
      const port = await freePort();
      const d = deps();
      const err = await rejection(cmdDaemonAttach({ path: checkoutDir, port: String(port), json: true }, d.deps));
      expect(err.code).toBe(1);
      expect(err.message).toContain(`http://127.0.0.1:${port}`);
      expect(JSON.parse(d.text()).reason).toBe('daemon-unreachable');
    });

    it('treats a rejecting fetch as daemon-unreachable', async () => {
      const d = deps({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
      const err = await rejection(cmdDaemonAttach({ path: checkoutDir, port: '1', json: true }, d.deps));
      expect(err.code).toBe(1);
      expect(JSON.parse(d.text()).reason).toBe('daemon-unreachable');
    });

    it('passes an unknown reason through and maps a missing one to unknown-failure', async () => {
      const p1 = await stubServer(400, JSON.stringify({ error: 'x', reason: 'future-code' }));
      const d1 = deps();
      const e1 = await rejection(cmdDaemonAttach({ path: checkoutDir, port: String(p1), json: true }, d1.deps));
      expect(e1.message).toBe('x');
      expect(JSON.parse(d1.text()).reason).toBe('future-code');

      const p2 = await stubServer(500);
      const d2 = deps();
      const e2 = await rejection(cmdDaemonAttach({ path: checkoutDir, port: String(p2), json: true }, d2.deps));
      expect(e2.message).toBe('HTTP 500');
      expect(JSON.parse(d2.text()).reason).toBe('unknown-failure');
    });

    it('reports not-a-git-checkout with a null repo and makes no HTTP call when there is no origin', async () => {
      let calls = 0;
      const d = deps({
        readOrigin: async () => null,
        fetch: () => {
          calls++;
          return Promise.reject(new Error('unexpected'));
        },
      });
      const err = await rejection(cmdDaemonAttach({ path: checkoutDir, json: true }, d.deps));
      expect(err.code).toBe(1);
      expect(calls).toBe(0);
      expect(JSON.parse(d.text())).toMatchObject({ ok: false, repo: null, reason: 'not-a-git-checkout' });
    });

    it('throws code 2 for an invalid --port before any I/O', async () => {
      const d = deps();
      const err = await rejection(cmdDaemonAttach({ port: 'zzz' }, d.deps));
      expect(err.code).toBe(2);
    });

    it('warns on stderr but succeeds when the event cannot be written', async () => {
      const port = await startDaemon();
      mkdirSync(join(checkoutDir, '.factory'), { recursive: true });
      writeFileSync(join(checkoutDir, '.factory', 'state'), 'a file, not a dir');
      const d = deps();
      await cmdDaemonAttach({ path: checkoutDir, port: String(port), json: true }, d.deps);
      expect(JSON.parse(d.text()).ok).toBe(true);
      expect(d.errText()).toContain('could not record repo-attached');
    });

    it('reads the port from daemon.port when --port is absent', async () => {
      const port = await startDaemon();
      writeFileSync(join(dir, 'daemon.port'), JSON.stringify({ port }));
      const d = deps();
      await cmdDaemonAttach({ path: checkoutDir, json: true }, d.deps);
      expect(JSON.parse(d.text()).ok).toBe(true);
    });
  });

  describe('cmdDaemonDetach', () => {
    it('detaches an attached repo, is idempotent, and appends repo-detached events', async () => {
      const port = await startDaemon();
      mkdirSync(join(checkoutDir, '.factory'), { recursive: true });
      const a = deps();
      await cmdDaemonAttach({ path: checkoutDir, port: String(port), json: true }, a.deps);

      const first = deps();
      await cmdDaemonDetach('acme/widget', { port: String(port), json: true }, first.deps);
      expect(JSON.parse(first.text())).toEqual({ schemaVersion: 1, ok: true, action: 'detach', repo: 'acme/widget' });
      // A 202 drains in the background and rewrites the registry; let it settle before repeating.
      await vi.waitFor(async () => {
        expect(listRepos(await loadRegistry(registryFile)).find((r) => r.slug === 'acme/widget')?.state).toBe(
          'detached',
        );
      });
      const again = deps();
      await cmdDaemonDetach('acme/widget', { port: String(port), json: true }, again.deps);
      expect(JSON.parse(again.text()).ok).toBe(true);

      const types = eventLines().map((l) => JSON.parse(l).type);
      expect(types).toEqual(['repo-attached', 'repo-detached', 'repo-detached']);
    });

    it('prints the text lines for 200 and 202', async () => {
      const p200 = await stubServer(200, '{}');
      const d1 = deps();
      await cmdDaemonDetach('acme/widget', { port: String(p200) }, d1.deps);
      expect(d1.text()).toBe('factoryd: detached acme/widget\n');
      const p202 = await stubServer(202, '{}');
      const d2 = deps();
      await cmdDaemonDetach('acme/widget', { port: String(p202) }, d2.deps);
      expect(d2.text()).toBe('factoryd: detaching acme/widget (draining in-flight lanes)\n');
    });

    it('reports unknown-repo with code 1 for an unattached slug', async () => {
      const port = await startDaemon();
      const d = deps();
      const err = await rejection(cmdDaemonDetach('acme/nope', { port: String(port), json: true }, d.deps));
      expect(err.code).toBe(1);
      expect(JSON.parse(d.text()).reason).toBe('unknown-repo');
    });

    it('reports daemon-unreachable when nothing listens', async () => {
      const port = await freePort();
      const d = deps();
      const err = await rejection(cmdDaemonDetach('acme/widget', { port: String(port), json: true }, d.deps));
      expect(err.code).toBe(1);
      expect(JSON.parse(d.text()).reason).toBe('daemon-unreachable');
    });

    it('rejects a malformed slug with invalid-request, code 2 and no fetch', async () => {
      let calls = 0;
      const fetchSpy = (() => {
        calls++;
        return Promise.reject(new Error('unexpected'));
      }) as typeof globalThis.fetch;
      for (const slug of ['', 'noslash', 'a/b/c', 'a/ b']) {
        const d = deps({ fetch: fetchSpy });
        const err = await rejection(cmdDaemonDetach(slug, { json: true }, d.deps));
        expect(err.code).toBe(2);
        expect(JSON.parse(d.text()).reason).toBe('invalid-request');
      }
      expect(calls).toBe(0);
    });
  });
});
