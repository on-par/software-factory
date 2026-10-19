// packages/cli/src/cli/daemon.test.ts — factory daemon start|stop|status|logs (#1179).

import { chmodSync, mkdtempSync, appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import {
  DEFAULT_FACTORYD_PORT,
  defaultRegistryPath,
  formatStopMarker,
  readStopMarker,
  type RunRuntime,
} from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonStatusJsonSchema } from './json-contract.js';
import {
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
  detectInstall,
  isUpdateCandidate,
  loadDaemonFileConfig,
  recoverStaleDrain,
  runAutoUpdateCycle,
  runAutoUpdateLoop,
  createAutoUpdateDeps,
  parseUpdateMode,
  renderFactorydPlist,
  resolveFactorydConfig,
  updateChannel,
} from './daemon.js';
import type {
  AutoUpdateApplyResult,
  AutoUpdateCheck,
  AutoUpdateDeps,
  DaemonCtlDeps,
  InstallInfo,
  LaunchctlExec,
} from './daemon.js';
import { initialUpdateState, readUpdateState, writeUpdateState, type UpdateState } from './update-state.js';

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

const npm: InstallInfo = { kind: 'npm-global', prefix: '/p', version: '1.0.0' };
const src: InstallInfo = { kind: 'source', prefix: '/p', version: '1.0.0' };
const unknown: InstallInfo = { kind: 'unknown', prefix: '/p', version: '1.0.0' };

describe('resolveFactorydConfig', () => {
  const registry = '/tmp/r.json';

  it('returns the registry, port, install and a resolved autoUpdate block', () => {
    const install: InstallInfo = { kind: 'unknown', prefix: '/p', version: '1.0.0' };
    expect(resolveFactorydConfig({ registry }, { install })).toEqual({
      registryFile: registry,
      port: DEFAULT_FACTORYD_PORT,
      autoUpdate: {
        mode: 'manual',
        requestedMode: 'manual',
        channel: null,
        checkIntervalMinutes: 30,
        drainTimeoutMinutes: 60,
      },
      install,
      notices: [],
    });
  });

  it('accepts the port bounds', () => {
    expect(resolveFactorydConfig({ registry, port: '0' }).port).toBe(0);
    expect(resolveFactorydConfig({ registry, port: '65535' }).port).toBe(65535);
  });

  it.each(['abc', '-1', '65536', '1.5'])('rejects invalid port %s with code 2', (port) => {
    let caught: unknown;
    try {
      resolveFactorydConfig({ registry, port }, { install: npm });
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

function codeOf(fn: () => unknown): { code: number; message: string } {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DaemonCtlError);
    return { code: (err as DaemonCtlError).code, message: (err as DaemonCtlError).message };
  }
  throw new Error('expected DaemonCtlError');
}

describe('updateChannel', () => {
  it('maps modes to dist-tags', () => {
    expect(updateChannel('stable')).toBe('latest');
    expect(updateChannel('prerelease')).toBe('next');
    expect(updateChannel('manual')).toBeNull();
  });
});

describe('parseUpdateMode', () => {
  it.each(['manual', 'stable', 'prerelease'] as const)('accepts %s', (m) => {
    expect(parseUpdateMode(m, '--update-mode')).toBe(m);
  });

  it.each(['nightly', '', 'STABLE', ' stable '])('rejects %j with DaemonCtlError code 2', (v) => {
    const res = codeOf(() => parseUpdateMode(v, '--update-mode'));
    expect(res.code).toBe(2);
    expect(res.message).toContain('manual, stable, prerelease');
    expect(res.message).toContain(`"${v}"`);
  });
});

describe('detectInstall', () => {
  const execPath = '/opt/node/bin/node';
  const npmCli = '/opt/node/lib/node_modules/@on-par/factory-cli/dist/cli.js';
  const no = () => false;

  it('classifies cli.js under <prefix>/lib/node_modules/@on-par/factory-cli as npm-global', () => {
    expect(detectInstall({ execPath, cliPath: npmCli, env: {}, version: '9.9.9', exists: no })).toEqual({
      kind: 'npm-global',
      prefix: '/opt/node',
      version: '9.9.9',
    });
  });

  it('FACTORY_FROM_SOURCE=1 is source', () => {
    const res = detectInstall({
      execPath,
      cliPath: npmCli,
      env: { FACTORY_FROM_SOURCE: '1' },
      version: '1',
      exists: no,
    });
    expect(res.kind).toBe('source');
  });

  it.each(['0', 'true', ''])('FACTORY_FROM_SOURCE=%j does not count', (v) => {
    const res = detectInstall({ execPath, cliPath: npmCli, env: { FACTORY_FROM_SOURCE: v }, version: '1', exists: no });
    expect(res.kind).toBe('npm-global');
  });

  it('a .git above cliPath is source', () => {
    const res = detectInstall({
      execPath,
      cliPath: '/src/sf/packages/cli/dist/cli.js',
      env: {},
      version: '1',
      exists: (p) => p === '/src/sf/.git',
    });
    expect(res.kind).toBe('source');
  });

  it('is unknown without a .git', () => {
    const res = detectInstall({
      execPath,
      cliPath: '/src/sf/packages/cli/dist/cli.js',
      env: {},
      version: '1',
      exists: no,
    });
    expect(res.kind).toBe('unknown');
  });

  it('does not match a sibling package', () => {
    const res = detectInstall({
      execPath,
      cliPath: '/opt/node/lib/node_modules/@on-par/factory-cli-extra/dist/cli.js',
      env: {},
      version: '1',
      exists: no,
    });
    expect(res.kind).toBe('unknown');
  });

  it('an empty cliPath is unknown', () => {
    expect(detectInstall({ execPath, cliPath: '', env: {}, version: '1', exists: () => true }).kind).toBe('unknown');
  });

  it('defaults read the real process without throwing', () => {
    const res = detectInstall();
    expect(['npm-global', 'source', 'unknown']).toContain(res.kind);
    expect(res.version).toMatch(/\d/);
  });
});

describe('loadDaemonFileConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} for a missing file', () => {
    expect(loadDaemonFileConfig(join(dir, 'daemon.json'))).toEqual({});
  });

  it('parses a valid file', () => {
    const file = join(dir, 'daemon.json');
    writeFileSync(file, JSON.stringify({ autoUpdate: { mode: 'prerelease', checkIntervalMinutes: 5 } }));
    expect(loadDaemonFileConfig(file)).toEqual({ autoUpdate: { mode: 'prerelease', checkIntervalMinutes: 5 } });
  });

  it.each(['{nope', '[]', 'null', '{"autoUpdate":5}', '{"autoUpdate":[]}'])('rejects %s with code 2', (body) => {
    const file = join(dir, 'daemon.json');
    writeFileSync(file, body);
    const res = codeOf(() => loadDaemonFileConfig(file));
    expect(res.code).toBe(2);
    expect(res.message).toContain(`invalid daemon config ${file}`);
  });
});

describe('resolveFactorydConfig update mode', () => {
  const registry = '/tmp/r.json';
  const resolve = (
    opts: { updateMode?: string; autoUpdate?: boolean },
    install: InstallInfo,
    fileConfig?: Parameters<typeof resolveFactorydConfig>[1] extends infer D
      ? D extends { fileConfig?: infer F }
        ? F
        : never
      : never,
  ) => resolveFactorydConfig({ registry, ...opts }, { install, fileConfig });

  it('defaults to stable/latest on an npm-global install', () => {
    const c = resolve({}, npm);
    expect(c.autoUpdate).toMatchObject({
      mode: 'stable',
      channel: 'latest',
      checkIntervalMinutes: 30,
      drainTimeoutMinutes: 60,
    });
    expect(c.notices).toEqual([]);
  });

  it.each([src, unknown])('defaults to manual with no notice on a $kind install', (install) => {
    const c = resolve({}, install);
    expect(c.autoUpdate.mode).toBe('manual');
    expect(c.autoUpdate.channel).toBeNull();
    expect(c.notices).toEqual([]);
  });

  it('downgrades a requested stable to manual on a source install with exactly one notice', () => {
    const c = resolve({ updateMode: 'stable' }, src);
    expect(c.notices).toEqual(['update mode stable needs an npm install; staying manual']);
    expect(c.autoUpdate).toMatchObject({ mode: 'manual', requestedMode: 'stable', channel: null });
  });

  it('downgrades prerelease, including one that comes from daemon.json', () => {
    expect(resolve({ updateMode: 'prerelease' }, unknown).notices).toEqual([
      'update mode prerelease needs an npm install; staying manual',
    ]);
    const c = resolve({}, src, { autoUpdate: { mode: 'stable' } });
    expect(c.notices).toEqual(['update mode stable needs an npm install; staying manual']);
    expect(c.autoUpdate.mode).toBe('manual');
  });

  it('honours manual from the flag and from daemon.json on an npm-global install', () => {
    expect(resolve({ updateMode: 'manual' }, npm).autoUpdate).toMatchObject({ mode: 'manual', channel: null });
    expect(resolve({}, npm, { autoUpdate: { mode: 'manual' } }).autoUpdate.mode).toBe('manual');
  });

  it('treats --auto-update as stable with exactly one deprecation notice', () => {
    const c = resolve({ autoUpdate: true }, npm);
    expect(c.autoUpdate.mode).toBe('stable');
    expect(c.notices).toEqual(['--auto-update is deprecated; use --update-mode stable']);
  });

  it('--update-mode wins over --auto-update, which still prints the notice', () => {
    const c = resolve({ updateMode: 'prerelease', autoUpdate: true }, npm);
    expect(c.autoUpdate).toMatchObject({ mode: 'prerelease', channel: 'next' });
    expect(c.notices).toEqual(['--auto-update is deprecated; use --update-mode stable']);
  });

  it('--auto-update beats daemon.json; --update-mode beats daemon.json', () => {
    expect(resolve({ autoUpdate: true }, npm, { autoUpdate: { mode: 'manual' } }).autoUpdate.mode).toBe('stable');
    expect(resolve({ updateMode: 'stable' }, npm, { autoUpdate: { mode: 'manual' } }).autoUpdate.mode).toBe('stable');
  });

  it('daemon.json can request prerelease on npm-global', () => {
    expect(resolve({}, npm, { autoUpdate: { mode: 'prerelease' } }).autoUpdate.channel).toBe('next');
  });

  it('daemon.json intervals override the defaults', () => {
    const c = resolve({}, npm, { autoUpdate: { checkIntervalMinutes: 5, drainTimeoutMinutes: 7 } });
    expect(c.autoUpdate).toMatchObject({ checkIntervalMinutes: 5, drainTimeoutMinutes: 7 });
  });

  it.each([0, -1, 1.5, '30'])('rejects interval %j with code 2', (v) => {
    expect(codeOf(() => resolve({}, npm, { autoUpdate: { checkIntervalMinutes: v } })).code).toBe(2);
    const res = codeOf(() => resolve({}, npm, { autoUpdate: { drainTimeoutMinutes: v } }));
    expect(res.code).toBe(2);
    expect(res.message).toContain('expected a positive integer');
  });

  it('rejects a bad daemon.json mode and --update-mode nightly with code 2', () => {
    expect(codeOf(() => resolve({}, npm, { autoUpdate: { mode: 'nightly' } })).message).toContain('autoUpdate.mode');
    const res = codeOf(() => resolve({ updateMode: 'nightly' }, npm));
    expect(res.code).toBe(2);
    expect(res.message).toContain('manual, stable, prerelease');
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
        expect(daemonStatusJsonSchema.parse(JSON.parse(text()))).toEqual({
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

describe('auto-update (#1939)', () => {
  let dir: string;
  let stop: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-update-'));
    stop = join(dir, 'repo', 'STOP');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = (mode: 'manual' | 'stable' | 'prerelease', version = '0.9.0') => ({
    autoUpdate: {
      mode,
      requestedMode: mode,
      channel: mode === 'manual' ? null : mode === 'stable' ? ('latest' as const) : ('next' as const),
      checkIntervalMinutes: 30,
      drainTimeoutMinutes: 60,
    },
    install: { kind: 'npm-global' as const, version, prefix: '/usr/local' } as InstallInfo,
  });
  const ok = (candidate: string): AutoUpdateCheck => ({ candidate, updateAvailable: true, error: null });

  function fakeDeps(
    config: ReturnType<typeof cfg>,
    over: {
      checks?: AutoUpdateCheck[];
      applies?: AutoUpdateApplyResult[];
      activeUntilPoll?: number;
      cycles?: number;
    } = {},
  ) {
    let t = Date.parse('2026-01-01T00:00:00Z');
    const start = t;
    const checks = [...(over.checks ?? [])];
    const applies = [...(over.applies ?? [{ code: 0, rolledBack: false, error: null }])];
    const applied: string[] = [];
    const sleeps: number[] = [];
    const exits: number[] = [];
    const logs: string[] = [];
    let polls = 0;
    let stopCalls = 0;
    let cycles = 0;
    const stateFile = join(dir, 'update-state.json');
    writeUpdateState(stateFile, initialUpdateState(config, null));
    const deps: AutoUpdateDeps = {
      stateFile,
      check: vi.fn(async () => checks.shift() ?? ok('0.9.0')),
      apply: vi.fn(async (v: string) => {
        applied.push(v);
        return applies.shift() ?? { code: 0, rolledBack: false, error: null };
      }),
      preflight: vi.fn(async () => ({ code: 0, rolledBack: false, error: null })),
      activeRuns: vi.fn(async () => {
        polls++;
        return polls <= (over.activeUntilPoll ?? 0) ? ['acme/app'] : [];
      }),
      writeStops: vi.fn(async () => {
        stopCalls++;
        mkdirSync(join(dir, 'repo'), { recursive: true });
        try {
          writeFileSync(stop, '', { flag: 'wx' });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') return [];
          throw err;
        }
        return [stop];
      }),
      clearStops: vi.fn(async (files: string[]) => {
        for (const f of files) rmSync(f, { force: true });
      }),
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
        if (ms === config.autoUpdate.checkIntervalMinutes * 60_000) cycles++;
      },
      log: (l) => logs.push(l),
      exit: (c) => {
        exits.push(c);
      },
      stopped: () => cycles > (over.cycles ?? 1),
    };
    return { deps, applied, sleeps, exits, logs, stateFile, elapsed: () => t - start, stopCalls: () => stopCalls };
  }

  describe('isUpdateCandidate', () => {
    it.each([
      [{ candidate: '0.9.1', updateAvailable: true, error: null }, 'stable', true],
      [{ candidate: '0.9.1', updateAvailable: false, error: null }, 'stable', false],
      [{ candidate: '0.9.1', updateAvailable: true, error: 'boom' }, 'stable', false],
      [{ candidate: null, updateAvailable: true, error: null }, 'stable', false],
      [{ candidate: '', updateAvailable: true, error: null }, 'stable', false],
      [{ candidate: '0.9.0', updateAvailable: true, error: null }, 'stable', false],
      [{ candidate: '0.9.1-next.0', updateAvailable: true, error: null }, 'stable', false],
      [{ candidate: '0.9.1-next.0', updateAvailable: true, error: null }, 'prerelease', true],
    ] as const)('%j in %s → %s', (check, mode, expected) => {
      expect(isUpdateCandidate(check, mode, '0.9.0')).toBe(expected);
    });
  });

  describe('runAutoUpdateCycle', () => {
    it('never applies while a run is active and records skipped after the drain timeout', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config, { checks: [ok('0.9.1')] });
      vi.mocked(f.deps.activeRuns).mockResolvedValue(['acme/app']);
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('drain-timeout');
      expect(f.deps.apply).not.toHaveBeenCalled();
      expect(existsSync(stop)).toBe(false);
      const state = readUpdateState(f.stateFile);
      expect(state?.lastResult).toMatchObject({ outcome: 'skipped', version: '0.9.1' });
      expect(state?.lastResult?.error).toContain('drain timed out after 60 min');
      expect(state?.draining).toBeNull();
      expect(f.elapsed()).toBeGreaterThanOrEqual(60 * 60_000);
    });

    it('ignores a prerelease candidate in stable mode', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config, { checks: [ok('0.9.1-next.0')] });
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('no-update');
      expect(f.deps.writeStops).not.toHaveBeenCalled();
      const state = readUpdateState(f.stateFile);
      expect(state?.available).toBeNull();
      expect(state?.lastCheckAt).not.toBeNull();
    });

    it('returns manual without touching any dep', async () => {
      const config = cfg('manual');
      const f = fakeDeps(config);
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('manual');
      for (const dep of [f.deps.check, f.deps.activeRuns, f.deps.writeStops, f.deps.apply]) {
        expect(dep).not.toHaveBeenCalled();
      }
    });

    it('records a check error and starts no drain', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config, { checks: [{ candidate: null, updateAvailable: false, error: 'registry down' }] });
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('check-error');
      expect(f.logs.some((l) => l.includes('update check failed: registry down'))).toBe(true);
      expect(readUpdateState(f.stateFile)?.lastCheckAt).not.toBeNull();
      expect(f.deps.writeStops).not.toHaveBeenCalled();
    });

    it('turns a throwing check into a check error and creates a missing state file', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config);
      rmSync(f.stateFile);
      vi.mocked(f.deps.check).mockRejectedValue(new Error('spawn failed'));
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('check-error');
      expect(readUpdateState(f.stateFile)).not.toBeNull();
    });

    it('does not remove a STOP that existed before the drain', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config, { checks: [ok('0.9.1')] });
      mkdirSync(join(dir, 'repo'), { recursive: true });
      writeFileSync(stop, '');
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('updated');
      expect(existsSync(stop)).toBe(true);
    });

    it('records skipped on a busy refusal and keeps the version eligible', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config, {
        checks: [ok('0.9.1'), ok('0.9.1')],
        applies: [{ code: 3, rolledBack: false, error: null }],
      });
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('busy');
      expect(readUpdateState(f.stateFile)?.lastResult).toMatchObject({ outcome: 'skipped' });
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('updated');
      expect(f.applied).toEqual(['0.9.1', '0.9.1']);
    });

    it('records rolled-back, and failed when apply throws', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config, {
        checks: [ok('0.9.1'), ok('0.9.2')],
        applies: [{ code: 1, rolledBack: true, error: 'doctor failed' }],
      });
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('failed');
      expect(readUpdateState(f.stateFile)?.lastResult).toMatchObject({
        outcome: 'rolled-back',
        error: 'doctor failed',
      });
      vi.mocked(f.deps.apply).mockRejectedValue(new Error('spawn'));
      expect(await runAutoUpdateCycle(config, f.deps)).toBe('failed');
      expect(readUpdateState(f.stateFile)?.lastResult).toMatchObject({ outcome: 'failed', error: 'spawn' });
      expect(existsSync(stop)).toBe(false);
    });
  });

  describe('runAutoUpdateLoop', () => {
    it('drains, applies the candidate once after the active run finishes, clears STOP and exits 75', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config, { checks: [ok('0.9.1')], activeUntilPoll: 2 });
      await runAutoUpdateLoop(config, f.deps);
      expect(f.applied).toEqual(['0.9.1']);
      expect(existsSync(stop)).toBe(false);
      expect(f.exits).toEqual([75]);
      expect(f.sleeps[0]).toBe(30 * 60_000);
      const state = readUpdateState(f.stateFile);
      expect(state?.lastResult).toMatchObject({ outcome: 'updated', version: '0.9.1' });
      expect(state?.draining).toBeNull();
    });

    it('does not retry a failed version and drains again for a newer one', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config, {
        checks: [ok('0.9.1'), ok('0.9.1'), ok('0.9.2')],
        applies: [
          { code: 1, rolledBack: false, error: 'install failed' },
          { code: 0, rolledBack: false, error: null },
        ],
        cycles: 3,
      });
      await runAutoUpdateLoop(config, f.deps);
      expect(f.applied).toEqual(['0.9.1', '0.9.2']);
      expect(f.stopCalls()).toBe(2);
      expect(f.exits).toEqual([75]);
    });

    it('manual mode never checks or writes STOP', async () => {
      const config = cfg('manual');
      const f = fakeDeps(config, { cycles: 3 });
      await runAutoUpdateLoop(config, f.deps);
      expect(f.deps.check).not.toHaveBeenCalled();
      expect(f.deps.activeRuns).not.toHaveBeenCalled();
      expect(f.deps.writeStops).not.toHaveBeenCalled();
      expect(existsSync(stop)).toBe(false);
    });

    it('keeps running when a cycle throws', async () => {
      const config = cfg('stable');
      const f = fakeDeps(config, { cycles: 2 });
      vi.mocked(f.deps.check).mockResolvedValue(ok('0.9.1'));
      vi.mocked(f.deps.writeStops).mockRejectedValue(new Error('disk'));
      await runAutoUpdateLoop(config, f.deps);
      expect(f.logs.filter((l) => l.includes('update cycle failed: disk'))).toHaveLength(2);
    });
  });

  describe('recoverStaleDrain', () => {
    it('removes the listed files, swallowing errors', () => {
      const prev = {
        ...initialUpdateState(cfg('stable'), null),
        draining: { since: 's', target: '0.9.1', stopFiles: ['/a', '/b', '/c'] },
      } satisfies UpdateState;
      const removed = recoverStaleDrain(prev, (f) => {
        if (f === '/b') throw new Error('nope');
        return f === '/a';
      });
      expect(removed).toEqual(['/a']);
      expect(recoverStaleDrain(null, () => true)).toEqual([]);
    });
  });

  describe('createAutoUpdateDeps', () => {
    function setup(over: { entrypoint?: string; runs?: ReturnType<RunRuntime['list']> } = {}) {
      const repo = join(dir, 'checkout');
      mkdirSync(repo, { recursive: true });
      const registryFile = join(dir, 'registry.json');
      writeFileSync(
        registryFile,
        JSON.stringify({
          version: 1,
          repos: {
            'acme/app': { path: repo, attachedAt: 'x', state: 'active' },
            'acme/gone': { path: join(dir, 'gone'), attachedAt: 'x', state: 'detached' },
          },
        }),
      );
      const logs: string[] = [];
      const check = vi.fn(async () => ok('0.9.1'));
      const deps = createAutoUpdateDeps({
        registryFile,
        stateFile: join(dir, 'update-state.json'),
        cliEntrypoint: over.entrypoint ?? '/nonexistent/cli.js',
        check,
        runRuntime: { list: () => over.runs ?? [] },
        log: (l) => logs.push(l),
        exit: () => {},
      });
      return { deps, repo, logs, check };
    }

    /** A stand-in CLI entrypoint: prints `stdout`, writes `stderr`, exits `code`. */
    function fakeCli(stdout: string, code: number, stderr = ''): string {
      const file = join(dir, `cli-${code}-${stdout.length}-${stderr.length}.mjs`);
      writeFileSync(
        file,
        `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${code});`,
      );
      return file;
    }

    it('writes and clears STOP exclusively and reports run-runtime activity', async () => {
      const { deps, check } = setup({
        runs: [
          { repo: 'acme/app', issue: 7, status: 'running' },
          { repo: 'acme/app', issue: 8, status: 'succeeded' },
        ] as ReturnType<RunRuntime['list']>,
      });
      expect(await deps.activeRuns()).toEqual(['daemon:acme/app#7']);
      const first = await deps.writeStops();
      expect(first).toHaveLength(1);
      expect(existsSync(first[0] as string)).toBe(true);
      expect(await deps.writeStops()).toEqual([]);
      await deps.clearStops(first);
      await deps.clearStops(first);
      expect(existsSync(first[0] as string)).toBe(false);
      expect(await deps.check()).toEqual(ok('0.9.1'));
      expect(check).toHaveBeenCalledOnce();
      expect((await deps.apply('0.9.1')).code).not.toBe(0);
      await deps.sleep(1);
      expect(deps.now()).toBeGreaterThan(0);
    });

    it('writeStops writes a self-update marker and does not overwrite an existing manual STOP', async () => {
      const { deps, repo } = setup();
      const stop = getFactoryPaths(repo).stop;
      const [written] = await deps.writeStops();
      expect(written).toBe(stop);
      expect(readStopMarker(stop)?.source).toBe('self-update');
      writeFileSync(stop, formatStopMarker('manual'));
      expect(await deps.writeStops()).toEqual([]);
      expect(readStopMarker(stop)?.source).toBe('manual');
    });

    it('clearStops leaves a STOP whose source is no longer self-update', async () => {
      const { deps } = setup();
      const files = await deps.writeStops();
      writeFileSync(files[0] as string, formatStopMarker('manual'));
      await deps.clearStops(files);
      expect(existsSync(files[0] as string)).toBe(true);
    });

    it('clearStops removes its own self-update STOP', async () => {
      const { deps } = setup();
      const files = await deps.writeStops();
      await deps.clearStops(files);
      expect(existsSync(files[0] as string)).toBe(false);
    });

    it('counts a repo whose run lock is held by a live pid as active', async () => {
      const { deps, repo } = setup();
      const lock = getFactoryPaths(repo).runLock;
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'pid'), String(process.pid));
      expect(await deps.activeRuns()).toEqual(['acme/app']);
    });

    it('logs a STOP it cannot write and keeps going', async () => {
      const { deps, repo, logs } = setup();
      rmSync(repo, { recursive: true });
      writeFileSync(repo, '');
      expect(await deps.writeStops()).toEqual([]);
      expect(logs.some((l) => l.startsWith('update: could not write STOP for acme/app'))).toBe(true);
    });

    it('rethrows a clearStops failure other than ENOENT', async () => {
      const { deps } = setup();
      const lockedDir = join(dir, 'locked');
      mkdirSync(lockedDir);
      const stop = join(lockedDir, 'STOP');
      writeFileSync(stop, formatStopMarker('self-update'));
      chmodSync(lockedDir, 0o500);
      try {
        await expect(deps.clearStops([stop])).rejects.toThrow();
      } finally {
        chmodSync(lockedDir, 0o700);
      }
    });

    it('apply reports success from `self-update --to --json`', async () => {
      const entrypoint = fakeCli(`noise\n${JSON.stringify({ outcome: 'updated' })}\n`, 0);
      const { deps } = setup({ entrypoint });
      expect(await deps.apply('0.9.1')).toEqual({ code: 0, rolledBack: false, error: null });
    });

    it('apply surfaces a rolled-back outcome and its JSON error', async () => {
      const entrypoint = fakeCli(JSON.stringify({ outcome: 'rolled-back', error: 'doctor failed' }), 1, 'ignored\n');
      const { deps } = setup({ entrypoint });
      expect(await deps.apply('0.9.1')).toEqual({ code: 1, rolledBack: true, error: 'doctor failed' });
    });

    it('apply falls back to the last stderr line, then the exit code', async () => {
      const withStderr = setup({ entrypoint: fakeCli('[1,2]', 4, 'first\nnpm ERR! boom\n') });
      expect(await withStderr.deps.apply('0.9.1')).toEqual({ code: 4, rolledBack: false, error: 'npm ERR! boom' });
      const bare = setup({ entrypoint: fakeCli('not json', 5) });
      expect(await bare.deps.apply('0.9.1')).toEqual({ code: 5, rolledBack: false, error: 'exit 5' });
    });
  });
});
