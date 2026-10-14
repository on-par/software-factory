// packages/cli/src/cli/daemon-start.test.ts — factory daemon start: bootout wait + bootstrap retry (#2922).

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cmdDaemonStart, DaemonCtlError, factorydFiles } from './daemon.js';
import type { DaemonCtlDeps, LaunchctlExec } from './daemon.js';
import { BOOTOUT_POLL_MS, BOOTOUT_WAIT_MS, BOOTSTRAP_ATTEMPTS, BOOTSTRAP_RETRY_MS } from './daemon-launchctl.js';

type FakeResult = { code: number; stdout?: string; stderr?: string };
interface ExecCall {
  cmd: string;
  args: string[];
}

/** Each launchctl subcommand maps to one result or a sequence consumed in order (the last repeats). */
function makeFakeExec(results: Record<string, FakeResult | FakeResult[]> = {}): {
  exec: LaunchctlExec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const seen: Record<string, number> = {};
  const exec: LaunchctlExec = (cmd, args) => {
    calls.push({ cmd, args });
    const key = args[0] ?? '';
    const entry = results[key] ?? { code: 0 };
    let r: FakeResult;
    if (Array.isArray(entry)) {
      const n = seen[key] ?? 0;
      seen[key] = n + 1;
      r = entry[Math.min(n, entry.length - 1)] ?? { code: 0 };
    } else {
      r = entry;
    }
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

const PRINT_RUNNING = ['system/com.onpar.factoryd = {', '\tstate = running', '\tpid = 123', '}'].join('\n');

describe('cmdDaemonStart', () => {
  let home: string;
  let sleeps: number[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'factory-daemon-start-test-'));
    sleeps = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
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
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };
  }

  it('writes the plist, creates .factory, and runs bootout → print → bootstrap → print against gui/<uid>', async () => {
    const { exec, calls } = makeFakeExec({
      print: [
        { code: 113, stderr: 'Could not find service' },
        { code: 0, stdout: PRINT_RUNNING },
      ],
    });
    const { out, text } = makeOut();
    await cmdDaemonStart(baseDeps(exec, out));

    const { plistPath } = factorydFiles(home);
    expect(existsSync(plistPath)).toBe(true);
    expect(existsSync(join(home, '.factory'))).toBe(true);
    expect(readFileSync(plistPath, 'utf-8')).toContain('<key>KeepAlive</key>');

    expect(calls).toEqual([
      { cmd: 'launchctl', args: ['bootout', 'gui/501/com.onpar.factoryd'] },
      { cmd: 'launchctl', args: ['print', 'gui/501/com.onpar.factoryd'] },
      { cmd: 'launchctl', args: ['bootstrap', 'gui/501', plistPath] },
      { cmd: 'launchctl', args: ['print', 'gui/501/com.onpar.factoryd'] },
    ]);
    expect(text()).toContain(`factoryd: installed ${plistPath}`);
    expect(text()).toContain('factoryd: running (pid 123)');
  });

  it('a bootout failure alone does not fail start', async () => {
    const { exec, calls } = makeFakeExec({
      bootout: { code: 3, stderr: 'Boot-out failed: 3: No such process' },
      print: { code: 0, stdout: 'state = waiting' },
    });
    const { out, text } = makeOut();
    await cmdDaemonStart(baseDeps(exec, out));
    expect(text()).toContain('factoryd: loaded — launchd will start it (RunAtLoad)');
    expect(calls.map((c) => c.args[0])).toEqual(['bootout', 'bootstrap', 'print']);
  });

  it('throws DaemonCtlError(1) with stderr text when bootstrap fails', async () => {
    const { exec } = makeFakeExec({ bootstrap: { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } });
    const { out } = makeOut();
    const err = await cmdDaemonStart(baseDeps(exec, out)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonCtlError);
    expect((err as DaemonCtlError).code).toBe(1);
    expect((err as DaemonCtlError).message).toContain('Bootstrap failed: 5');
  });

  it('waits for launchctl print to report the job gone before bootstrap', async () => {
    const { exec, calls } = makeFakeExec({
      print: [{ code: 0 }, { code: 0 }, { code: 113 }, { code: 0, stdout: PRINT_RUNNING }],
    });
    const { out, text } = makeOut();
    await cmdDaemonStart(baseDeps(exec, out));
    expect(calls.map((c) => c.args[0])).toEqual(['bootout', 'print', 'print', 'print', 'bootstrap', 'print']);
    expect(sleeps).toEqual([BOOTOUT_POLL_MS, BOOTOUT_POLL_MS]);
    expect(text()).toContain('factoryd: running (pid 123)');
  });

  it('retries a transient bootstrap EIO (code 5) and succeeds', async () => {
    const { exec, calls } = makeFakeExec({
      bootout: { code: 3 },
      bootstrap: [{ code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }, { code: 0 }],
    });
    const { out } = makeOut();
    await cmdDaemonStart(baseDeps(exec, out));
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toHaveLength(2);
    expect(sleeps).toEqual([BOOTSTRAP_RETRY_MS]);
  });

  it('gives up after BOOTSTRAP_ATTEMPTS on persistent EIO with the launchctl text and bounded sleeps', async () => {
    const { exec, calls } = makeFakeExec({
      bootout: { code: 0 },
      print: { code: 0 },
      bootstrap: { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' },
    });
    const { out } = makeOut();
    const err = await cmdDaemonStart(baseDeps(exec, out)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonCtlError);
    expect((err as DaemonCtlError).code).toBe(1);
    expect((err as DaemonCtlError).message).toContain('Bootstrap failed: 5: Input/output error');
    const firstBootstrap = calls.findIndex((c) => c.args[0] === 'bootstrap');
    expect(calls.slice(0, firstBootstrap).filter((c) => c.args[0] === 'print')).toHaveLength(
      Math.ceil(BOOTOUT_WAIT_MS / BOOTOUT_POLL_MS),
    );
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toHaveLength(BOOTSTRAP_ATTEMPTS);
    let retryBudget = 0;
    for (let a = 1; a < BOOTSTRAP_ATTEMPTS; a++) retryBudget += BOOTSTRAP_RETRY_MS * a;
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(BOOTOUT_WAIT_MS + retryBudget);
  });

  it('does not retry a non-EIO bootstrap failure', async () => {
    const { exec, calls } = makeFakeExec({
      bootout: { code: 3 },
      bootstrap: { code: 37, stderr: 'Bootstrap failed: 37' },
    });
    const { out } = makeOut();
    const err = await cmdDaemonStart(baseDeps(exec, out)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonCtlError);
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toHaveLength(1);
  });
});
