// packages/cli/src/cli/daemon.test.ts — factory daemon start|stop|status|logs (#1179).

import { mkdtempSync, appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_FACTORYD_PORT, defaultRegistryPath } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  loadDaemonFileConfig,
  parseUpdateMode,
  renderFactorydPlist,
  resolveFactorydConfig,
  updateChannel,
} from './daemon.js';
import type { DaemonCtlDeps, InstallInfo, LaunchctlExec } from './daemon.js';

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
