// packages/cli/src/cli/runner.test.ts — factory daemon runner install|uninstall|list (#2282).

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DaemonCtlError } from './daemon.js';
import type { DaemonCtlDeps, LaunchctlExec } from './daemon.js';
import {
  cmdRunnerInstall,
  cmdRunnerList,
  cmdRunnerUninstall,
  normalizeRunnerLabel,
  parseRunnerEnv,
  renderRunnerPlist,
  renderRunnerScript,
  runnerFiles,
} from './runner.js';

interface ExecCall {
  cmd: string;
  args: string[];
}

let root: string;
let home: string;
let checkout: string;
let calls: ExecCall[];
let results: Record<string, { code: number; stdout?: string; stderr?: string }>;
let outBuf: string;

function deps(over: Partial<DaemonCtlDeps> = {}): DaemonCtlDeps {
  const exec: LaunchctlExec = (cmd, args) => {
    calls.push({ cmd, args });
    const r = results[`${args[0]}:${args[1] ?? ''}`] ?? results[args[0] ?? ''] ?? { code: 0 };
    return Promise.resolve({ code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  };
  return {
    exec,
    home,
    uid: 501,
    platform: 'darwin',
    out: {
      write: (s: string) => {
        outBuf += s;
        return true;
      },
    },
    nodePath: '/usr/local/bin/node',
    cliScriptPath: '/opt/factory/cli.js',
    registryFile: join(home, '.factory', 'registry.json'),
    env: { PATH: '/bin' },
    ...over,
  };
}

function codeOf(fn: () => Promise<unknown>): Promise<{ code: number; message: string }> {
  return fn().then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(DaemonCtlError);
      return { code: (e as DaemonCtlError).code, message: (e as DaemonCtlError).message };
    },
  );
}

function writeRegistry(path: string, state: string): void {
  mkdirSync(join(home, '.factory'), { recursive: true });
  writeFileSync(
    join(home, '.factory', 'registry.json'),
    JSON.stringify({
      schemaVersion: 1,
      repos: { 'o/r': { path, attachedAt: '2026-01-01T00:00:00Z', state } },
    }),
  );
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'runner-')));
  home = join(root, 'home');
  checkout = join(root, 'My Repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  calls = [];
  results = {};
  outBuf = '';
});

afterEach(() => {
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('normalizeRunnerLabel', () => {
  it('defaults to the sanitized checkout basename', () => {
    expect(normalizeRunnerLabel(undefined, '/x/My Repo')).toBe('my-repo');
  });
  it('strips the label prefix and sanitizes', () => {
    expect(normalizeRunnerLabel('com.onpar.factory-sf', '/x')).toBe('sf');
    expect(normalizeRunnerLabel(' a/b c ', '/x')).toBe('a-b-c');
  });
  it('throws code 2 when empty after normalizing', () => {
    expect(() => normalizeRunnerLabel('  ', '/x')).toThrow(DaemonCtlError);
    expect(() => normalizeRunnerLabel('///', '/x')).toThrow(/invalid --label/);
  });
});

describe('parseRunnerEnv', () => {
  it('parses pairs, empty values, first-= split, last wins', () => {
    expect(parseRunnerEnv(undefined)).toEqual({});
    expect(parseRunnerEnv(['A=', 'B=b=c', 'C=1', 'C=2'])).toEqual({ A: '', B: 'b=c', C: '2' });
  });
  it('rejects malformed pairs with code 2', () => {
    for (const bad of ['NOEQ', '=v', '1A=x', 'A-B=x']) {
      try {
        parseRunnerEnv([bad]);
        throw new Error('expected throw');
      } catch (e) {
        expect((e as DaemonCtlError).code).toBe(2);
      }
    }
  });
});

describe('renderers', () => {
  it('renders the plist', () => {
    const p = renderRunnerPlist({
      label: 'com.onpar.factory-x',
      scriptPath: '/s.sh',
      checkout: '/a&b',
      logPath: '/l.log',
    });
    expect(p).toContain('<key>WorkingDirectory</key>\n  <string>/a&amp;b</string>');
    expect(p).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(p).toContain('<string>/l.log</string>');
    expect(p).toContain('<string>/bin/bash</string>');
  });
  it('renders the script', () => {
    const s = renderRunnerScript({
      checkout: '/c',
      nodePath: '/n/node',
      cliScriptPath: '/c/cli.js',
      logPath: '/c/runner.log',
      env: { Z: "it's", A: '1' },
    });
    expect(s.startsWith('#!/bin/bash\n')).toBe(true);
    expect(s).toContain("cd '/c' || exit 1");
    expect(s.indexOf("export A='1'")).toBeLessThan(s.indexOf('export Z='));
    expect(s).toContain(`export Z='it'\\''s'`);
    expect(s).toContain("'/n/node' '/c/cli.js' run >> \"$LOG\" 2>&1");
    expect(s).toContain('sleep 90');
  });
  it('renders the script without env', () => {
    const s = renderRunnerScript({ checkout: '/c', nodePath: '/n', cliScriptPath: '/j', logPath: '/l', env: {} });
    expect(s).toContain("exit 1\nLOG='/l'");
  });
});

describe('cmdRunnerInstall', () => {
  const files = () => runnerFiles(home, 'my-repo');

  it('bootstraps the plist into gui/<uid> and reports the pid from launchctl print', async () => {
    results.print = { code: 0, stdout: '\tpid = 4242\n' };
    await cmdRunnerInstall(checkout, { env: ['A=1'] }, deps());
    const f = files();
    expect(calls).toEqual([
      { cmd: 'launchctl', args: ['bootout', `gui/501/${f.label}`] },
      { cmd: 'launchctl', args: ['bootstrap', 'gui/501', f.plistPath] },
      { cmd: 'launchctl', args: ['print', `gui/501/${f.label}`] },
    ]);
    expect(existsSync(f.plistPath)).toBe(true);
    expect(statSync(f.scriptPath).mode & 0o111).not.toBe(0);
    const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
    expect(manifest.checkout).toBe(checkout);
    expect(manifest.env.A).toBe('1');
    expect(outBuf).toContain('running (pid 4242)');
  });

  it('says loaded when there is no pid and includes FACTORY_STATE_ROOT', async () => {
    await cmdRunnerInstall(checkout, {}, deps({ env: { PATH: '/bin', FACTORY_STATE_ROOT: join(root, 'state') } }));
    expect(outBuf).toContain('loaded');
    expect(readFileSync(files().scriptPath, 'utf8')).toContain('export FACTORY_STATE_ROOT=');
  });

  it('falls back to a default PATH', async () => {
    await cmdRunnerInstall(checkout, {}, deps({ env: {} }));
    expect(readFileSync(files().scriptPath, 'utf8')).toContain("export PATH='/usr/bin:/bin'");
  });

  it('refuses a second install for the same checkout and a factoryd-attached checkout', async () => {
    await cmdRunnerInstall(checkout, {}, deps());
    calls = [];
    const second = await codeOf(() => cmdRunnerInstall(checkout, { label: 'other' }, deps()));
    expect(second.code).toBe(1);
    expect(second.message).toContain('already has a runner');
    expect(calls).toEqual([]);

    const other = join(root, 'other');
    mkdirSync(other);
    writeRegistry(other, 'active');
    const managed = await codeOf(() => cmdRunnerInstall(other, {}, deps()));
    expect(managed.code).toBe(1);
    expect(managed.message).toContain('managed by factoryd');
    expect(existsSync(runnerFiles(home, 'other').plistPath)).toBe(false);

    writeRegistry(other, 'detached');
    await cmdRunnerInstall(other, {}, deps());
    expect(existsSync(runnerFiles(home, 'other').plistPath)).toBe(true);
  });

  it('leaves a hand-rolled plist untouched and ignores unparsable manifests', async () => {
    const f = files();
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(join(home, '.factory', 'runners'), { recursive: true });
    writeFileSync(f.plistPath, 'hand-rolled');
    writeFileSync(join(home, '.factory', 'runners', 'junk.json'), '{nope');
    const err = await codeOf(() => cmdRunnerInstall(checkout, {}, deps()));
    expect(err.code).toBe(1);
    expect(err.message).toContain('already exists');
    expect(readFileSync(f.plistPath, 'utf8')).toBe('hand-rolled');
    expect(existsSync(f.scriptPath)).toBe(false);
  });

  it('--json prints one object on success and on refusal', async () => {
    await cmdRunnerInstall(checkout, { json: true }, deps());
    const f = files();
    expect(JSON.parse(outBuf)).toEqual({ ok: true, label: f.label, plist: f.plistPath, script: f.scriptPath });
    expect(outBuf.trim().split('\n')).toHaveLength(1);

    outBuf = '';
    await cmdRunnerInstall(checkout, { json: true }, deps());
    const fail = JSON.parse(outBuf);
    expect(fail.ok).toBe(false);
    expect(fail.label).toBe(f.label);
    expect(process.exitCode).toBe(1);
  });

  it('--json reports a label of null for an invalid label', async () => {
    await cmdRunnerInstall(checkout, { json: true, label: '///' }, deps());
    expect(JSON.parse(outBuf)).toMatchObject({ ok: false, label: null });
    expect(process.exitCode).toBe(2);
  });

  it('rethrows non-DaemonCtlError failures even with --json', async () => {
    await expect(cmdRunnerInstall(join(root, 'missing'), { json: true }, deps())).rejects.toThrow(/ENOENT/);
  });

  it('turns a bootstrap failure into code 1 with stderr', async () => {
    results.bootstrap = { code: 5, stderr: 'Bootstrap failed: 5\n' };
    const err = await codeOf(() => cmdRunnerInstall(checkout, {}, deps()));
    expect(err.code).toBe(1);
    expect(err.message).toContain('Bootstrap failed: 5');
    results.bootstrap = { code: 7 };
    expect((await codeOf(() => cmdRunnerInstall(checkout, {}, deps()))).message).toBeTruthy();
  });

  it('exits 2 on non-darwin and writes nothing', async () => {
    const err = await codeOf(() => cmdRunnerInstall(checkout, {}, deps({ platform: 'linux' })));
    expect(err.code).toBe(2);
    expect(err.message).toContain('factory daemon runner requires macOS launchd');
    expect(existsSync(files().plistPath)).toBe(false);
  });
});

describe('cmdRunnerUninstall', () => {
  it('boots out and removes all three files', async () => {
    await cmdRunnerInstall(checkout, {}, deps());
    calls = [];
    const f = runnerFiles(home, 'my-repo');
    await cmdRunnerUninstall(checkout, {}, deps());
    expect(calls).toEqual([{ cmd: 'launchctl', args: ['bootout', `gui/501/${f.label}`] }]);
    for (const p of [f.plistPath, f.scriptPath, f.manifestPath]) expect(existsSync(p)).toBe(false);
    expect(outBuf).toContain(`runner: uninstalled ${f.label}`);
  });

  it('--json prints {ok,label,plist,script}', async () => {
    await cmdRunnerInstall(checkout, {}, deps());
    outBuf = '';
    await cmdRunnerUninstall(checkout, { json: true }, deps());
    const f = runnerFiles(home, 'my-repo');
    expect(JSON.parse(outBuf)).toEqual({ ok: true, label: f.label, plist: f.plistPath, script: f.scriptPath });
  });

  it('refuses without a manifest and keeps a hand-rolled plist', async () => {
    const f = runnerFiles(home, 'my-repo');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(f.plistPath, 'hand-rolled');
    const err = await codeOf(() => cmdRunnerUninstall(checkout, {}, deps()));
    expect(err.code).toBe(1);
    expect(existsSync(f.plistPath)).toBe(true);
    expect(calls).toEqual([]);
    await cmdRunnerUninstall(checkout, { json: true }, deps());
    expect(JSON.parse(outBuf)).toMatchObject({ ok: false });
  });
});

describe('cmdRunnerList', () => {
  it('lists manifests with running state, sorted', async () => {
    const a = join(root, 'a');
    mkdirSync(a);
    await cmdRunnerInstall(checkout, {}, deps());
    await cmdRunnerInstall(a, {}, deps());
    outBuf = '';
    results.print = { code: 0, stdout: 'pid = 7\n' };
    const fa = runnerFiles(home, 'a');
    const base = deps();
    const exec = base.exec!;
    await cmdRunnerList(
      { json: true },
      {
        ...base,
        exec: async (cmd, args) =>
          args[1]?.endsWith(fa.label) ? exec(cmd, args) : { code: 113, stdout: '', stderr: '' },
      },
    );
    const parsed = JSON.parse(outBuf);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.runners.map((r: { label: string }) => r.label)).toEqual([
      fa.label,
      runnerFiles(home, 'my-repo').label,
    ]);
    expect(parsed.runners[0]).toMatchObject({ running: true, pid: 7, checkout: a });
    expect(parsed.runners[1]).toMatchObject({ running: false, pid: null });

    outBuf = '';
    await cmdRunnerList({}, deps());
    expect(outBuf).toContain(`${fa.label} running (pid 7) ${a}`);
  });

  it('handles a missing runners dir', async () => {
    await cmdRunnerList({ json: true }, deps());
    expect(JSON.parse(outBuf)).toEqual({ schemaVersion: 1, runners: [] });
    outBuf = '';
    await cmdRunnerList({}, deps());
    expect(outBuf).toBe('runners: none\n');
  });
});
