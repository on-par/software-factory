import type * as ChildProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { eventSegmentFileName, eventSegmentsDir } from '@on-par/factory-core/internal';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

import { FACTORYD_LABEL, factorydFiles } from './cli/daemon.js';
import { HELP_GROUPS, OTHER_GROUP } from './cli/help-groups.js';
import { CliExitError, cmdConstitution, LaneParkError, ghRepoViewFailureMessage } from './cli/index.js';
import {
  cmdUsage,
  coreFakes,
  errored,
  exitSpy,
  h,
  installCliCommandsHarness,
  logged,
  logSpy,
  ops,
  paths,
  phases,
  runMain,
  runMainWith,
  setupWorktree,
  shipIssue,
  trackEnv,
} from './cli/test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('resume --from check (#2564)', () => {
    const recordPath = () => join(paths().plans, 'issue-5.check-resume.json');
    const configEnvFail = () => {
      h.checkResult = {
        passed: false,
        summary: { results: [], failures: 1 },
        reworkRounds: 0,
        environment: { baseSha: 'b'.repeat(40), failingChecks: ['unknown-checker'], cause: 'config', logPaths: [] },
      };
    };
    const writeRecord = (worktree: string) => {
      mkdirSync(paths().plans, { recursive: true });
      writeFileSync(
        recordPath(),
        JSON.stringify({
          issue: 5,
          branch: 'kept-branch',
          worktree,
          diffBase: 'dbase',
          route: 'claude',
          model: 'kept-model',
          buildMinutes: 40,
          fixTarget: '.factory/constitution.md:3',
          preservedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    };

    it('a config-caused CHECK failure parks and records no resume point (#2583)', async () => {
      configEnvFail();
      const err = await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LaneParkError);
      expect((err as LaneParkError).reason).toBe('config');
      expect(existsSync(recordPath())).toBe(false);
      expect(readFileSync(paths().events, 'utf-8')).toContain('factory unpark 5');
    });

    it('resume <issue> --from check runs CHECK in the kept worktree without setupWorktree, planPhase or buildPhase', async () => {
      const kept = join(h.repoRoot, 'kept-worktree');
      mkdirSync(kept, { recursive: true });
      writeRecord(kept);
      const res = await runMain('resume', '5', '--from', 'check');
      expect(res.exited).toBe(false);
      expect(setupWorktree).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase.mock.calls[0][0]).toMatchObject({
        worktree: kept,
        diffBase: 'dbase',
        reworkModel: 'kept-model',
      });
      expect(existsSync(recordPath())).toBe(false);
    });

    it.each([
      ['no --from', ['resume', '5']],
      ['an unsupported phase', ['resume', '5', '--from', 'build']],
      ['--from without an issue', ['resume', '--from', 'check']],
      ['an invalid issue', ['resume', 'abc', '--from', 'check']],
      ['no preserved build', ['resume', '5', '--from', 'check']],
    ])('exits 2 and leaves STOP untouched for %s', async (_name, args) => {
      writeFileSync(paths().stop, '');
      const res = await runMain(...args);
      expect(res).toEqual({ exited: true, code: 2 });
      expect(existsSync(paths().stop)).toBe(true);
      expect(phases.checkPhase).not.toHaveBeenCalled();
    });

    it('exits 2 when the recorded worktree no longer exists', async () => {
      writeRecord(join(h.repoRoot, 'gone'));
      const res = await runMain('resume', '5', '--from', 'check');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(phases.checkPhase).not.toHaveBeenCalled();
    });
  });

  describe('stop / resume', () => {
    it('stop writes the STOP file', async () => {
      await runMain('stop');
      expect(existsSync(paths().stop)).toBe(true);
      expect(logged()).toContain('STOP set');
    });

    it('stop routes git rev-parse through the injected exec seam', async () => {
      const commands: string[] = [];
      const recordingExec = async (cmd: string) => {
        commands.push(cmd);
        return { stdout: `${h.repoRoot}\n`, stderr: '' };
      };
      await runMainWith({ exec: recordingExec }, 'stop');
      expect(commands).toContain('git rev-parse --show-toplevel');
      expect(existsSync(paths().stop)).toBe(true);
    });

    it('resume removes an existing STOP file', async () => {
      writeFileSync(paths().stop, '');
      await runMain('resume');
      expect(existsSync(paths().stop)).toBe(false);
      expect(logged()).toContain('STOP cleared');
    });

    it('resume is a no-op when there is no STOP file', async () => {
      await runMain('resume');
      expect(logged()).toContain('STOP cleared');
    });

    it('stop says a running ship finishes its current issue and the next one will not start (#2544)', async () => {
      await runMain('stop');
      expect(logged()).toMatch(/factory ship.*finishes its current issue.*won't start.*factory resume/);
    });

    it('resume text output is byte-identical without --json', async () => {
      await runMain('resume');
      expect(logged()).toBe('STOP cleared');
    });

    it('stop --json prints one JSON object when not stopped', async () => {
      await runMain('stop', '--json');
      expect(existsSync(paths().stop)).toBe(true);
      expect(logged().split('\n')).toHaveLength(1);
      expect(JSON.parse(logged())).toEqual({
        schemaVersion: 1,
        ok: true,
        action: 'stop',
        repo: h.ghRepo,
        stopFlag: { before: false, after: true },
      });
    });

    it('stop --json is idempotent when already stopped', async () => {
      writeFileSync(paths().stop, '');
      await runMain('stop', '--json');
      expect(existsSync(paths().stop)).toBe(true);
      expect(JSON.parse(logged())).toMatchObject({ ok: true, stopFlag: { before: true, after: true } });
    });

    it('resume --json reports before/after with and without STOP', async () => {
      writeFileSync(paths().stop, '');
      await runMain('resume', '--json');
      expect(existsSync(paths().stop)).toBe(false);
      expect(JSON.parse(logged())).toMatchObject({ action: 'resume', stopFlag: { before: true, after: false } });
    });

    it('stop leaves an existing STOP file untouched (exclusive create, no rewrite)', async () => {
      writeFileSync(paths().stop, 'set by lane');
      await runMain('stop', '--json');
      expect(readFileSync(paths().stop, 'utf-8')).toBe('set by lane');
      expect(JSON.parse(logged())).toMatchObject({ stopFlag: { before: true, after: true } });
    });

    it('resume surfaces unlink errors other than a missing STOP file', async () => {
      mkdirSync(join(paths().stop, 'nested'), { recursive: true });
      await expect(runMain('resume', '--json')).rejects.toMatchObject({ code: expect.stringMatching(/^E/) });
      expect(existsSync(paths().stop)).toBe(true);
    });

    it('resume --json is ok when STOP was not set', async () => {
      await runMain('resume', '--json');
      expect(JSON.parse(logged())).toMatchObject({ ok: true, stopFlag: { before: false, after: false } });
    });

    it('stop --json has the same shape as the golden fixture', async () => {
      await runMain('stop', '--json');
      const golden = JSON.parse(
        readFileSync(new URL('./__fixtures__/stop-resume-json/stop.json', import.meta.url), 'utf-8'),
      ) as { stopFlag: object };
      const out = JSON.parse(logged()) as { stopFlag: object };
      expect(Object.keys(out)).toEqual(Object.keys(golden));
      expect(Object.keys(out.stopFlag)).toEqual(Object.keys(golden.stopFlag));
    });

    it('records stop-file-set / stop-file-cleared events without echoing them', async () => {
      const types = () =>
        readFileSync(paths().events, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { type: string }).type);
      await runMain('stop');
      expect(types()).toEqual(['stop-file-set']);
      expect(logged()).toMatch(/^STOP set: lanes halt between issues/);
      await runMain('resume');
      expect(types()).toEqual(['stop-file-set', 'stop-file-cleared']);
    });

    it('stop --json fails with exit 2 and writes nothing when repo lookup fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) throw new Error('gh not authenticated');
        return '';
      };
      const res = await runMain('stop', '--json');
      expect(res).toMatchObject({ exited: true, code: 2 });
      expect(errored()).toContain('no GitHub remote detected');
      expect(logged()).toBe('');
      expect(existsSync(paths().stop)).toBe(false);
    });
  });

  describe('proxy', () => {
    it('starts the foreground proxy, prints routes, and shuts down cleanly on SIGINT', async () => {
      h.factoryConfig = {
        ...h.factoryConfig,
        environment: { proxy: { enabled: true, port: 0, domain: 'factory.localhost' } },
      };
      writeFileSync(
        join(paths().state, 'ports.json'),
        JSON.stringify({
          version: 1,
          leases: [
            {
              worktreeId: '/repo/ship-it-296',
              branch: 'ship-it/296',
              port: 3142,
              pid: process.pid,
              acquiredAt: new Date().toISOString(),
            },
          ],
        }),
      );

      const runPromise = runMain('proxy');
      while (!logged().includes('listening on')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      process.emit('SIGINT');
      const res = await runPromise;

      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
      expect(logged()).toContain('ship-it-296.factory.localhost -> 127.0.0.1:3142');
      expect(existsSync(join(paths().state, 'proxy.json'))).toBe(false);
    });

    it('warns but still starts when environment.proxy.enabled is false (the command is the explicit opt-in)', async () => {
      h.factoryConfig = {
        ...h.factoryConfig,
        environment: { proxy: { enabled: false, port: 0, domain: 'factory.localhost' } },
      };

      const runPromise = runMain('proxy');
      while (!logged().includes('listening on')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(logged()).toContain('explicit opt-in');
      process.emit('SIGINT');
      await runPromise;
    });
  });

  describe('daemon', () => {
    it('starts the foreground factoryd, serves the registry, and shuts down cleanly on SIGINT', async () => {
      const registryFile = join(paths().state, 'registry.json');
      writeFileSync(
        registryFile,
        JSON.stringify({
          version: 1,
          repos: {
            'on-par/software-factory': {
              path: h.repoRoot,
              attachedAt: '2026-01-01T00:00:00.000Z',
              state: 'active',
            },
          },
        }),
      );

      const runPromise = runMain('daemon', 'run', '--port', '0', '--registry', registryFile);
      while (!logged().includes('listening on 127.0.0.1:')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(logged()).toContain(registryFile);

      // Runtime state lives in dirname(registryFile) while the daemon is up (#1177).
      const pidFile = join(paths().state, 'daemon.pid');
      const portFile = join(paths().state, 'daemon.port');
      const logFile = join(paths().state, 'daemon.log');
      const boundPort = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(logged())![1]);
      expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
      expect(JSON.parse(readFileSync(portFile, 'utf-8'))).toEqual({
        pid: process.pid,
        port: boundPort,
        host: '127.0.0.1',
      });

      process.emit('SIGINT');
      const res = await runPromise;

      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      expect(existsSync(portFile)).toBe(false);
      expect(readFileSync(logFile, 'utf-8')).toContain(`factoryd: listening on 127.0.0.1:${boundPort}`);
    });

    it('daemon run --help lists --update-mode and the deprecated --auto-update', async () => {
      const originalWrite = process.stdout.write.bind(process.stdout);
      const written: string[] = [];
      process.stdout.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('daemon', 'run', '--help');
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(res.exited).toBe(true);
      const text = written.join('').replace(/\s+/g, ' ');
      expect(text).toContain('--update-mode');
      expect(text).toContain('manual, stable');
      expect(text).toContain('--auto-update');
      expect(text).toContain('Deprecated');
    });

    it('accepts --auto-update and starts and stops exactly like the default run', async () => {
      const registryFile = join(paths().state, 'registry.json');
      writeFileSync(registryFile, JSON.stringify({ version: 1, repos: {} }));

      const runPromise = runMain('daemon', 'run', '--auto-update', '--port', '0', '--registry', registryFile);
      while (!logged().includes('listening on 127.0.0.1:')) {
        await new Promise((r) => setTimeout(r, 5));
      }

      process.emit('SIGINT');
      const res = await runPromise;

      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
    });

    it('exits with code 2 on an invalid --port and never binds', async () => {
      const res = await runMain('daemon', 'run', '--port', 'abc');
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(logged()).not.toContain('listening on');
    });

    it('exits with code 2 on --update-mode nightly and lists the valid modes', async () => {
      const registryFile = join(paths().state, 'registry.json');
      const res = await runMain('daemon', 'run', '--update-mode', 'nightly', '--registry', registryFile);
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(logged()).not.toContain('listening on');
    });

    const bootout = { cmd: 'launchctl', args: ['bootout', `gui/501/${FACTORYD_LABEL}`] };
    const print = { cmd: 'launchctl', args: ['print', `gui/501/${FACTORYD_LABEL}`] };

    it('daemon start installs the plist and bootstraps it through launchctl', async () => {
      const { plistPath } = factorydFiles(h.daemonHome);
      let prints = 0;
      h.daemonExecImpl = (_cmd, args) =>
        args[0] === 'print' && prints++ === 0
          ? { code: 113, stdout: '', stderr: 'Could not find service' }
          : { code: 0, stdout: '', stderr: '' };
      const res = await runMain('daemon', 'start');
      expect(res.exited).toBe(false);
      expect(h.daemonExecCalls).toEqual([
        bootout,
        print,
        { cmd: 'launchctl', args: ['bootstrap', 'gui/501', plistPath] },
        print,
      ]);
      expect(existsSync(plistPath)).toBe(true);
      expect(readFileSync(plistPath, 'utf-8')).toContain('/opt/factory/cli.js');
      expect(h.daemonOut.join('')).toContain('factoryd: installed');
    });

    it('daemon stop boots the agent out through launchctl', async () => {
      const res = await runMain('daemon', 'stop');
      expect(res.exited).toBe(false);
      expect(h.daemonExecCalls).toEqual([bootout]);
      expect(h.daemonOut.join('')).toContain('factoryd: stopped');
    });

    it('daemon status reports the pid and uptime of the running agent', async () => {
      h.daemonExecImpl = (cmd) =>
        cmd === 'launchctl'
          ? { code: 0, stdout: '\tpid = 4242\n', stderr: '' }
          : { code: 0, stdout: '01:02\n', stderr: '' };
      const res = await runMain('daemon', 'status');
      expect(res.exited).toBe(false);
      expect(h.daemonExecCalls).toEqual([print, { cmd: 'ps', args: ['-o', 'etime=', '-p', '4242'] }]);
      const out = h.daemonOut.join('');
      expect(out).toContain('factoryd: running (pid 4242, uptime 01:02)');
      expect(out).toContain('attached repos: none');
    });

    it('daemon status --json prints one JSON object for the running agent', async () => {
      h.daemonExecImpl = (cmd) =>
        cmd === 'launchctl'
          ? { code: 0, stdout: '\tpid = 4242\n', stderr: '' }
          : { code: 0, stdout: '01:02\n', stderr: '' };
      const res = await runMain('daemon', 'status', '--json');
      expect(res.exited).toBe(false);
      expect(JSON.parse(h.daemonOut.join(''))).toEqual({
        schemaVersion: 1,
        running: true,
        pid: 4242,
        uptimeSec: 62,
        plistInstalled: false,
        repos: [],
        load: expect.objectContaining({ maxSlots: expect.any(Number) }),
      });
    });

    it('daemon status (plain text) on linux exits 2 with nothing on stdout', async () => {
      h.daemonPlatform = 'linux';
      const res = await runMain('daemon', 'status');
      expect(res.code).toBe(2);
      expect(h.daemonOut).toEqual([]);
      expect(errored()).toContain('requires macOS launchd');
    });

    it('daemon logs -n prints the last N lines of the log', async () => {
      const { logPath } = factorydFiles(h.daemonHome);
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, Array.from({ length: 10 }, (_, i) => `line${i + 1}\n`).join(''));
      const res = await runMain('daemon', 'logs', '-n', '3');
      expect(res.exited).toBe(false);
      expect(h.daemonOut.join('')).toBe('line8\nline9\nline10\n');
      expect(h.daemonExecCalls).toEqual([]);
    });

    it('daemon logs -f returns early when no log exists yet', async () => {
      // Never create a log file here: follow mode would then block on SIGINT.
      const res = await runMain('daemon', 'logs', '-f', '-n', '7');
      expect(res.exited).toBe(false);
      expect(h.daemonOut.join('')).toContain('no daemon log yet');
    });

    it('maps DaemonCtlError onto the CLI exit code', async () => {
      h.daemonPlatform = 'linux';
      const res = await runMain('daemon', 'status');
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(h.daemonExecCalls).toEqual([]);
    });

    it('refuses to start when a live daemon holds the pid file, leaving it untouched', async () => {
      const registryFile = join(paths().state, 'registry.json');
      const pidFile = join(paths().state, 'daemon.pid');
      // The test process itself is alive by construction.
      writeFileSync(pidFile, `${process.pid}\n`);

      const res = await runMain('daemon', 'run', '--port', '0', '--registry', registryFile);

      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(errored()).toContain(`factoryd already running (pid ${process.pid})`);
      expect(readFileSync(pidFile, 'utf-8')).toBe(`${process.pid}\n`);
      expect(logged()).not.toContain('listening on');
    });

    it('a stale pid file from a killed daemon does not block a restart', async () => {
      const registryFile = join(paths().state, 'registry.json');
      writeFileSync(registryFile, JSON.stringify({ version: 1, repos: {} }));
      const pidFile = join(paths().state, 'daemon.pid');
      // A real (bypassing the module mock) short-lived child yields a pid that
      // is guaranteed dead once spawnSync returns.
      const { spawnSync } = await vi.importActual<typeof ChildProcess>('node:child_process');
      const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
      writeFileSync(pidFile, `${deadPid}\n`);

      const runPromise = runMain('daemon', 'run', '--port', '0', '--registry', registryFile);
      while (!logged().includes('listening on 127.0.0.1:')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(logged()).toContain(`removed stale pid file (pid ${deadPid})`);
      expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));

      process.emit('SIGINT');
      const res = await runPromise;
      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
    });
  });

  describe('worktree gc', () => {
    it('dry-run calls sweepWorktrees with dryRun: true and takes no lock', async () => {
      h.gcReport = { removed: [], kept: 3, dryRun: true };
      const lockHeld: boolean[] = [];
      ops.sweepWorktrees.mockImplementationOnce(async () => {
        lockHeld.push(existsSync(paths().gitLock));
        return h.gcReport;
      });
      const res = await runMain('worktree', 'gc', '--dry-run');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, dryRun: true }),
        expect.anything(),
      );
      expect(lockHeld).toEqual([false]);
      expect(logged()).toContain('GC_REPORT:dry:removed=0:kept=3');
    });

    it('--ttl-days overrides the config default', async () => {
      const res = await runMain('worktree', 'gc', '--ttl-days', '3');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(expect.objectContaining({ ttlDays: 3 }), expect.anything());
    });

    it('--branch-prefix sf is passed to sweepWorktrees', async () => {
      const res = await runMain('worktree', 'gc', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ branchPrefix: 'sf' }),
        expect.anything(),
      );
    });

    it('run.branchPrefix in the repo config is the default, and --branch-prefix beats it', async () => {
      h.factoryConfig = { ...h.factoryConfig, run: { branchPrefix: 'Acme Bots' } };
      expect((await runMain('worktree', 'gc')).exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenLastCalledWith(
        expect.objectContaining({ branchPrefix: 'acme-bots' }),
        expect.anything(),
      );
      expect((await runMain('worktree', 'gc', '--branch-prefix', 'sf')).exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenLastCalledWith(
        expect.objectContaining({ branchPrefix: 'sf' }),
        expect.anything(),
      );
    });

    it('exits 2 when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('worktree', 'gc', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');
    });

    it('exits 2 on a non-numeric --ttl-days', async () => {
      const res = await runMain('worktree', 'gc', '--ttl-days', 'nope');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--ttl-days');
    });
  });

  describe('reset', () => {
    it('prints one summary line per issue and exits 0 when nothing is found', async () => {
      const lockHeld: boolean[] = [];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        lockHeld.push(existsSync(paths().gitLock));
        return '';
      };
      const res = await runMain('reset', '555', '556');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('#555: nothing to reset');
      expect(logged()).toContain('#556: nothing to reset');
      expect(lockHeld).toContain(true);
    });

    it('--dry-run previews without taking the git lock', async () => {
      const lockHeld: boolean[] = [];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        lockHeld.push(existsSync(paths().gitLock));
        return '';
      };
      const res = await runMain('reset', '555', '--dry-run');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('#555 (dry run): nothing to reset');
      expect(lockHeld.length).toBeGreaterThan(0);
      expect(lockHeld.every((held) => !held)).toBe(true);
    });

    it('runs the dirty probe through exec and keeps a dirty worktree (#1789)', async () => {
      const wt = join(h.repoRoot, '..', 'wt-777');
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('worktree list')) return `worktree ${wt}\nHEAD abc\nbranch refs/heads/factory/777-x\n`;
        if (cmd.includes('git status')) return ' M a.ts\n';
        return '';
      };
      const res = await runMain('reset', '777', '--dry-run');
      expect(res.exited).toBe(false);
      expect(logged()).toContain(`would keep worktree ${wt} (uncommitted changes; pass --force to remove)`);
      expect(logged()).not.toContain('would remove worktree');
    });

    it('exits 2 on a non-numeric issue', async () => {
      const res = await runMain('reset', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('expected a positive integer issue number');
    });

    it('exits 2 when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('reset', '5', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
    });
  });

  describe('local-small-dry-run', () => {
    it('creates the dry-run plan and context and prints their paths', async () => {
      const res = await runMain('local-small-dry-run', '5');
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('/tmp/plan.md');
      expect(out).toContain('/tmp/ctx.md');
    });
  });

  describe('local-small-overnight', () => {
    it('exits 2 mentioning the expected path when the queue file is missing', async () => {
      const res = await runMain('local-small-overnight');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain(join(paths().state, 'local-small', 'overnight-queue'));
    });

    it('exits 2 when the queue file has only malformed lines', async () => {
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'not a valid line\n');
      const res = await runMain('local-small-overnight');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('malformed');
    });

    it('runs the happy path: ships the queued issue and records it as ready', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight ready: 1');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'ready' })]);
    });

    it('exits 4 mentioning halted when preflight fails', async () => {
      h.claudeAvailable = false;
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res).toEqual({ exited: true, code: 4 });
      expect(errored()).toContain('halted');
    });

    it('exits 4 mentioning no reachable local worker when no worker-tier model is reachable', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: false, experimental: false, reason: 'no key' },
      ];
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res).toEqual({ exited: true, code: 4 });
      expect(errored()).toContain('no reachable local worker model');
    });

    it('parks an item, reports it, and logs overnight-park when shipIssue escalates', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight parked: 1');
      expect(logged()).toContain('parked');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('overnight-park');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'parked' })]);
    });

    // Regression (#681): the curated overnight queue needs a human to prune it —
    // a closed issue maps to 'parked', not 'ready' or 'failed'.
    it('parks a closed issue for a human, reports it, and logs overnight-park', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight parked: 1');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('skipped-already-closed');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'parked' })]);
    });
  });

  describe('resume-approved', () => {
    it('exits 2 when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('resume-approved', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');
    });

    it('resolves cleanly when there are no open factory PRs', async () => {
      const res = await runMain('resume-approved');
      expect(res.exited).toBe(false);
      expect(errored()).toBe('');
    });

    it('exits 5 and reports failed PRs when landing an approved PR fails', async () => {
      h.octokit.graphql = vi.fn(async (query: string) => {
        if (query.includes('OpenFactoryPRs')) {
          return {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { number: 12, headRefName: 'factory/5-fix-the-bug', reviewDecision: 'APPROVED', isDraft: false },
                ],
              },
            },
          };
        }
        return {};
      });
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw new Error('issue vanished');
      });
      const res = await runMain('resume-approved');
      expect(res).toEqual({ exited: true, code: 5 });
      expect(logged()).toContain('failed to land');
      expect(errored()).toContain('1 PR(s) failed to land');
    });
  });

  describe('ship (via cmdShip)', () => {
    it('runs worktree gc before shipping when worktree.autoGcOnRun is true (#1756)', async () => {
      h.factoryConfig = { ...h.factoryConfig, worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: true } };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, repo: h.ghRepo }),
        expect.objectContaining({ octokit: expect.anything() }),
      );
      expect(ops.formatGcReport).toHaveBeenCalled();
    });

    it('does not run worktree gc when worktree.autoGcOnRun is false (#1756)', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).not.toHaveBeenCalled();
    });

    it('names the branch with the default factory prefix when --branch-prefix is omitted', async () => {
      const branches: string[] = [];
      h.setupWorktreeImpl = async (_r, branch) => {
        branches.push(branch);
      };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(branches[0]).toEqual('factory/5-fix-the-bug');
    });

    it('names the branch and worktree with --branch-prefix sf', async () => {
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('ship', '5', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toEqual('sf/5-fix-the-bug');
      expect(calls[0][1]).toContain('-factory-sf-');
    });

    it('exits 2 before any phase runs when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('ship', '5', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');
      expect(phases.planPhase).not.toHaveBeenCalled();
    });
    it('ships an issue through all phases and prints the ready PR', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
    });

    // Regression (#681): a closed issue exits 0 (not 1) through the CLI command.
    it('exits 0 on a closed issue instead of failing', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('skipped:');
    });

    it('reports already-delivered instead of "ready for review" when SHIP recovery finds a prior merged PR (#520)', async () => {
      h.shipResult = { ok: true, prNumber: 518, alreadyDelivered: true };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('already delivered by merged PR #518');
      expect(logged()).not.toContain('PR #518 ready for review');
    });

    it('reports the branch as already landed on main when SHIP recovery finds no merged PR for it (#520)', async () => {
      h.shipResult = { ok: true, alreadyDelivered: true };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('already delivered — branch already landed on main');
      expect(logged()).not.toContain('PR #undefined');
    });

    it('prints a yellow SKIP line for a skipped checker while the run still succeeds', async () => {
      h.checkResult = {
        passed: true,
        summary: {
          results: [
            {
              checker: 'tests',
              result: 'SKIP',
              details: 'no verification command was run — no scripts/verify.sh and no package.json test script found',
            },
          ],
          failures: 0,
        },
        reworkRounds: 0,
      };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('SKIP: tests');
    });

    it('exits 1 and logs a park event when a check fails', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const failEvents = events.filter((e: any) => e.type === 'fail' && e.issue === '5');
      expect(failEvents).toHaveLength(1);
      expect(errored()).toContain('Ship failed');
    });

    it('exits 1 and logs exactly one park event when a check fails under FACTORY_LOCAL_ONLY=1', async () => {
      trackEnv('FACTORY_LOCAL_ONLY');
      process.env.FACTORY_LOCAL_ONLY = '1';
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const failEvents = events.filter((e: any) => e.type === 'fail' && e.issue === '5');
      expect(failEvents).toHaveLength(1);
      expect(errored()).toContain('Ship failed');
    });

    it('reaches shipPhase without an approval gate when --interactive is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const call = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
      expect(call.approvalGate).toBeUndefined();
    });

    it('passes an approval gate to shipPhase when --interactive is set', async () => {
      const res = await runMain('ship', '5', '--interactive');
      expect(res.exited).toBe(false);
      const call = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
      expect(typeof call.approvalGate).toBe('function');
    });

    it('reaches planPhase without an approval gate when --approve-plan is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const call = phases.planPhase.mock.calls.at(-1)?.[0] as any;
      expect(call.approvalGate).toBeUndefined();
      expect(call.enforceReadiness).toBe(true);
      expect(call?.enforceSizeGate).toBe(true);
      expect(call.drainSteering).toBeUndefined();
    });

    it('passes an approval gate and drainSteering to planPhase when --approve-plan is set', async () => {
      const res = await runMain('ship', '5', '--approve-plan');
      expect(res.exited).toBe(false);
      const call = phases.planPhase.mock.calls.at(-1)?.[0] as any;
      expect(typeof call.approvalGate).toBe('function');
      expect(typeof call.drainSteering).toBe('function');
    });

    it('passes the agent prerequisite with only the codex CLI on PATH (#1269)', async () => {
      coreFakes.isCommandAvailable.mockImplementation((c: string) => c === 'codex' || c === 'git' || c === 'gh');
      const res = await runMain('ship', '5');
      expect(errored()).not.toContain('no coding agent CLI');
      expect(errored()).not.toContain('claude CLI not found');
      expect(phases.planPhase).toHaveBeenCalled();
      expect(!res.exited || res.code !== 2).toBe(true);
    });

    it('exits 2 with the missing-agent message and never invokes the phase mocks when no agent CLI is available', async () => {
      h.claudeAvailable = false;
      const res = await runMain('ship', '42');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no coding agent CLI found on PATH');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('parses --no-sandbox to opts.sandbox === false and logs sandbox disabled by the CLI flag', async () => {
      const res = await runMain('ship', '5', '--no-sandbox');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('sandbox disabled by --no-sandbox — agent runs are UNCONTAINED');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'sandbox-disabled' && e.msg.includes('--no-sandbox'))).toBe(true);
    });

    it('defaults --sandbox to true (no CLI-disabled event) when the flag is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).not.toContain('sandbox disabled by --no-sandbox');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'sandbox-disabled' && e.msg.includes('--no-sandbox'))).toBe(false);
    });

    it('warns that FACTORY_MERGE does not apply to ship and names factory land/run (#978)', async () => {
      process.env.FACTORY_MERGE = '1';
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('FACTORY_MERGE=1 ignored');
      expect(errored()).toContain('factory land 5');
      expect(errored()).toContain('factory run');
      expect(logged()).toContain('PR #99 ready for review');
    });

    it('records the ignored-merge notice as a warn event (#978)', async () => {
      process.env.FACTORY_MERGE = '1';
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const warnEvents = events.filter((e: any) => e.type === 'warn' && e.issue === '5' && e.msg.includes('ignored'));
      expect(warnEvents).toHaveLength(1);
    });

    it('warns for FACTORY_MERGE_ADMIN alone (#978)', async () => {
      process.env.FACTORY_MERGE_ADMIN = '1';
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('FACTORY_MERGE_ADMIN=1 ignored');
    });

    it('prints no merge notice when neither variable is set (#978)', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).not.toContain('ignored —');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'warn' && e.msg.includes('ignored'))).toBe(false);
    });
  });

  describe('run-issue (one-shot)', () => {
    it.each(['ship', 'run-issue'])(
      '%s refuses a pull request number before any model or plan call (#2492)',
      async (cmd) => {
        h.octokit.rest.issues.get = vi.fn(async () => ({
          data: { title: 'Add subtract (#1)', body: 'Closes #1', pull_request: { url: 'x' } },
        }));
        const routerRun = vi.fn(h.routerRun);
        h.routerRun = routerRun;
        const res = await runMain(cmd, '2');
        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('#2 is a pull request, not an issue. Did you mean issue #1?');
        expect(phases.planPhase).not.toHaveBeenCalled();
        expect(routerRun).not.toHaveBeenCalled();
      },
    );

    it('runs worktree gc before shipping when worktree.autoGcOnRun is true (#1756)', async () => {
      h.factoryConfig = { ...h.factoryConfig, worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: true } };
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, repo: h.ghRepo }),
        expect.objectContaining({ octokit: expect.anything() }),
      );
      expect(ops.formatGcReport).toHaveBeenCalled();
    });

    it('does not run worktree gc when worktree.autoGcOnRun is false (#1756)', async () => {
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).not.toHaveBeenCalled();
    });

    describe('--size-gate (#2048)', () => {
      const enforced = () => phases.planPhase.mock.calls.at(-1)?.[0].enforceSizeGate;

      it('enforces the size gates with no config and no flag', async () => {
        await runMain('run-issue', '5');
        expect(enforced()).toBe(true);
      });

      it('skips the size gates when sizeGate.mode is off in the config', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'off' } };
        await runMain('run-issue', '5');
        expect(enforced()).toBe(false);
      });

      it('--size-gate off beats a file config', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'file' } };
        await runMain('run-issue', '5', '--size-gate', 'off');
        expect(enforced()).toBe(false);
      });

      it('an unset sizeGate.mode passes sizeGateMode stack to planPhase', async () => {
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('stack');
      });

      const stubStack = () => {
        h.octokit.request = vi.fn().mockResolvedValue({ data: [] });
        h.octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      };
      let warnSpy: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      });
      afterEach(() => warnSpy.mockRestore());
      const deprecationLines = () =>
        warnSpy.mock.calls.map((c: unknown[]) => c.join(' ')).filter((l: string) => l.includes('deprecated'));

      it.each(['file', 'slice'])(
        '--size-gate %s prints one deprecation line naming --stack and runs as --stack',
        async (mode) => {
          stubStack();
          await runMain('run-issue', '5', '--size-gate', mode);
          expect(deprecationLines()).toHaveLength(1);
          expect(deprecationLines()[0]).toContain('--stack');
          expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('stack');
        },
      );

      it('--size-gate off skips the size gates with no deprecation line', async () => {
        await runMain('run-issue', '5', '--size-gate', 'off');
        expect(enforced()).toBe(false);
        expect(deprecationLines()).toHaveLength(0);
      });

      it('--size-gate stack runs as --stack with no deprecation line', async () => {
        stubStack();
        await runMain('run-issue', '5', '--size-gate', 'stack');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('stack');
        expect(deprecationLines()).toHaveLength(0);
      });

      it.each(['file', 'slice'])(
        'sizeGate.mode %s in the config prints one deprecation line and passes sizeGateMode stack to planPhase',
        async (mode) => {
          h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode } };
          await runMain('run-issue', '5');
          expect(deprecationLines()).toHaveLength(1);
          expect(deprecationLines()[0]).toContain('--stack');
          expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('stack');
        },
      );

      it('sizeGate.mode stack in the config passes sizeGateMode stack to planPhase', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'stack' } };
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('stack');
      });

      it('--max-slices 6 passes maxSlices 6 to planPhase (ADR-0156)', async () => {
        await runMain('run-issue', '5', '--max-slices', '6');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].maxSlices).toBe(6);
      });

      it('sizeGate.maxSlices in the config is used when the flag is absent', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'slice', maxSlices: 7 } };
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].maxSlices).toBe(7);
      });

      it('defaults maxSlices to 10 with neither flag nor config', async () => {
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].maxSlices).toBe(10);
      });

      it.each(['0', '21', '2.5', 'abc', ''])('rejects --max-slices %j with exit 2 before planning', async (value) => {
        const res = await runMain('run-issue', '5', '--max-slices', value);
        expect(res).toMatchObject({ exited: true, code: 2 });
        expect(errored()).toContain('--max-slices');
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('rejects an unknown mode with exit 2 before planning', async () => {
        const res = await runMain('run-issue', '5', '--size-gate', 'bogus');
        expect(res).toMatchObject({ exited: true, code: 2 });
        expect(errored()).toContain('--size-gate');
        expect(errored()).toContain('file');
        expect(errored()).toContain('off');
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('--help lists --size-gate', async () => {
        const originalWrite = process.stdout.write;
        const written: string[] = [];
        process.stdout.write = ((chunk: string | Uint8Array) => {
          written.push(String(chunk));
          return true;
        }) as typeof process.stdout.write;
        try {
          await runMain('run-issue', '--help');
        } finally {
          process.stdout.write = originalWrite;
        }
        expect(written.join('')).toContain('--size-gate');
        expect(written.join('')).toContain('slice');
      });
    });

    it('names the branch with the default factory prefix when --branch-prefix is omitted', async () => {
      const branches: string[] = [];
      h.setupWorktreeImpl = async (_r, branch) => {
        branches.push(branch);
      };
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(branches[0]).toEqual('factory/5-fix-the-bug');
    });

    it('names the branch and worktree with --branch-prefix sf', async () => {
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('run-issue', '5', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toEqual('sf/5-fix-the-bug');
      expect(calls[0][1]).toContain('-factory-sf-');
    });
    it('names the child issues and points at --stack when the size gate decomposes the issue', async () => {
      h.planResult = { ok: false, route: 'claude', escalate: 'decomposed', decomposed: { childIssues: [10, 11] } };
      const res = await runMain('run-issue', '5');
      expect(res).toMatchObject({ exited: true, code: 1 });
      expect(errored()).toContain('#10');
      expect(errored()).toContain('#11');
      expect(errored()).toContain('--stack');
      expect(errored()).not.toContain('--run-children');
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    describe('--run-children (removed)', () => {
      const removedMessage = '--run-children was removed; oversized issues stack with --stack';
      it.each([
        ['', []],
        ['with --no-pr', ['--no-pr']],
        ['with --base-branch', ['--base-branch', 'main']],
      ])('--run-children %s exits 2 with the removal message before any worktree or PR', async (_name, extra) => {
        const res = await runMain('run-issue', '5', '--run-children', ...(extra as string[]));
        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain(removedMessage);
        expect(setupWorktree).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
        expect(phases.shipPhase).not.toHaveBeenCalled();
      });
    });

    // Regression (#681): a closed issue exits 0 (not 1) through the CLI command,
    // reusing the ctx.workRequest resolved by this command's own preflight.
    it('exits 0 on a closed issue instead of failing', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('skipped:');
      expect(h.octokit.rest.issues.get).toHaveBeenCalledTimes(1);
    });

    it('leaves the queue file untouched', async () => {
      writeFileSync(paths().queue, 'app 7\ndocs 9\n');
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\ndocs 9\n');
    });

    it('rejects a non-numeric identifier before any work', async () => {
      const res = await runMain('run-issue', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid issue argument');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
    });

    it('rejects a zero identifier before any work', async () => {
      const res = await runMain('run-issue', '0');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid issue argument');
    });

    it('fails pre-flight with exit 2 when the issue is unreachable — no worktree, no PR', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw new Error('Not Found');
      });
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('could not resolve issue #5');
      expect(errored()).toContain('no worktree or PR was created');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('maps a pipeline failure to exit 1, not a pre-flight error', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('Run failed for issue #5');
    });

    it('exits 2 with the missing-agent message and never invokes the phase mocks when no agent CLI is available', async () => {
      h.claudeAvailable = false;
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no coding agent CLI found on PATH');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('reports invalid work-request input as a pre-flight error, not a generic resolve failure', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return 'not-a-valid-repo-slug';
        return '';
      };
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid input for work-request source');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });
  });

  describe('run-brief (one-shot)', () => {
    const VALID_BRIEF = `# Add a widget

Please add a widget that does the thing.

## Acceptance criteria

- the widget exists
`;

    function writeBrief(content = VALID_BRIEF): string {
      const briefPath = join(h.repoRoot, 'brief.md');
      writeFileSync(briefPath, content);
      return briefPath;
    }

    function readEventLines(): any[] {
      return readFileSync(paths().events, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    }

    const workspaceDirs: string[] = [];

    function writeWorkspace(): string {
      const ws = mkdtempSync(join(tmpdir(), 'factory-ws-'));
      mkdirSync(join(ws, '.git'));
      workspaceDirs.push(ws);
      return ws;
    }

    it.each([
      [[], /^factory\//, false],
      [['--branch-prefix', 'sf'], /^sf\//, true],
    ] as const)('creates the worktree branch for prefix args %j', async (extra, pattern, sf) => {
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('run-brief', writeBrief(), ...extra);
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toMatch(pattern);
      if (sf) expect(calls[0][1]).toContain('-factory-sf-');
    });

    afterEach(() => {
      for (const ws of workspaceDirs.splice(0)) rmSync(ws, { recursive: true, force: true });
    });

    it('resolves the brief through the canonical work-request seam and ships it through all phases', async () => {
      const briefPath = writeBrief();
      const digest = createHash('sha256').update(VALID_BRIEF).digest('hex');

      const res = await runMain('run-brief', briefPath);

      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
      expect(logged()).toContain('local-brief:');
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).toHaveBeenCalledTimes(1);
      expect(phases.checkPhase).toHaveBeenCalledTimes(1);
      expect(phases.shipPhase).toHaveBeenCalledTimes(1);
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(vi.mocked(setupWorktree)).toHaveBeenCalled();

      const planArgs = phases.planPhase.mock.calls.at(-1)?.[0] as any;
      expect(planArgs.workSource).toEqual({ kind: 'local-brief', params: { path: briefPath } });

      const buildArgs = phases.buildPhase.mock.calls.at(-1)?.[0] as any;
      expect(buildArgs.disablePublish).toBeFalsy();

      const shipArgs = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
      expect(shipArgs.work).toMatchObject({ kind: 'local-brief' });

      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('inline local brief');
      expect(events).toContain(digest);

      const workSourceEvent = readEventLines().find((e) => e.type === 'work-source');
      expect(workSourceEvent.issue).toMatch(/^9\d{6}$/);
    });

    it('leaves the queue file untouched', async () => {
      writeFileSync(paths().queue, 'app 7\ndocs 9\n');
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\ndocs 9\n');
    });

    it('fails pre-flight with exit 2 on a malformed brief — no worktree, no BUILD', async () => {
      const briefPath = writeBrief('# Add a widget\n\nPlease add a widget that does the thing.\n');

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no acceptance criteria');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
    });

    it('fails pre-flight with exit 2 when the brief file is missing — no worktree, no PR', async () => {
      const briefPath = join(h.repoRoot, 'does-not-exist.md');

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('could not resolve brief');
      expect(errored()).toContain('no worktree or PR was created');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the missing-agent message and never invokes the phase mocks when no agent CLI is available', async () => {
      h.claudeAvailable = false;
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no coding agent CLI found on PATH');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('maps a pipeline failure to exit 1, not a pre-flight error', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('Run failed for brief');
    });

    describe.each(['live file', 'rotated segment'])(
      'human-restarted when the prior park sits in the %s (#3711)',
      (where) => {
        it.each(['ship', 'run-issue', 'run-brief'])('%s', async (cmd) => {
          const digest = createHash('sha256').update(VALID_BRIEF).digest('hex');
          const issue =
            cmd === 'run-brief' ? String(9_000_000 + (Number.parseInt(digest.slice(0, 8), 16) % 1_000_000)) : '5';
          const fail = JSON.stringify({ ts: '2026-07-01T00:00:00.000Z', type: 'fail', issue, msg: 'checker failures' });
          if (where === 'live file') writeFileSync(paths().events, fail + '\n');
          else {
            mkdirSync(eventSegmentsDir(paths().events), { recursive: true });
            writeFileSync(join(eventSegmentsDir(paths().events), eventSegmentFileName(0)), fail + '\n');
          }
          const res = await runMain(cmd, cmd === 'run-brief' ? writeBrief() : '5');
          expect(res.exited).toBe(false);
          const events = readFileSync(paths().events, 'utf-8');
          expect(events).toContain('human-restarted');
          expect(events).toContain('manual retry of a previously parked/failed run');
        });
      },
    );

    describe('--workspace (local-only)', () => {
      it('runs PLAN/BUILD/CHECK in the caller workspace, disables publish, and skips SHIP', async () => {
        const ws = writeWorkspace();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res.exited).toBe(false);
        expect(logged()).toContain('Local-only run complete');
        expect(logged()).toContain('publishing disabled');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.shipPhase).not.toHaveBeenCalled();

        expect(phases.planPhase).toHaveBeenCalledTimes(1);
        expect(phases.buildPhase).toHaveBeenCalledTimes(1);
        expect(phases.checkPhase).toHaveBeenCalledTimes(1);
        expect(phases.planPhase.mock.calls.at(-1)?.[0]).toMatchObject({ worktree: ws });
        expect(phases.buildPhase.mock.calls.at(-1)?.[0]).toMatchObject({
          worktree: ws,
          disablePublish: true,
        });
        expect(phases.checkPhase.mock.calls.at(-1)?.[0]).toMatchObject({ worktree: ws });

        expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();

        const events = readFileSync(paths().events, 'utf-8');
        expect(events).toContain('local-only');
        expect(events).toContain(ws);
      });

      it('needs no GitHub remote — getGitHubRepo is never called', async () => {
        const ws = writeWorkspace();
        const briefPath = writeBrief();
        h.execImpl = (cmd: string) => {
          if (cmd.includes('rev-parse')) return h.repoRoot;
          if (cmd.includes('gh repo view')) throw new Error('no GitHub remote configured');
          return '';
        };

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res.exited).toBe(false);
        expect(logged()).toContain('Local-only run complete');
      });

      it('leaves the queue file byte-identical', async () => {
        writeFileSync(paths().queue, 'app 7\ndocs 9\n');
        const ws = writeWorkspace();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res.exited).toBe(false);
        expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\ndocs 9\n');
      });

      it('exits 2 before any pipeline call when the workspace is missing', async () => {
        const missing = join(tmpdir(), 'factory-ws-does-not-exist-xyz');
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', missing);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('invalid local-only workspace');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
        expect(phases.buildPhase).not.toHaveBeenCalled();
      });

      it('exits 2 before any pipeline call when the workspace has no .git', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'factory-ws-'));
        workspaceDirs.push(ws);
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('not an initialized git repository');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
      });
    });

    describe('--artifacts (benchmark manifest)', () => {
      const artifactsDirs: string[] = [];

      function writeArtifactsDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'factory-artifacts-'));
        artifactsDirs.push(dir);
        return dir;
      }

      afterEach(() => {
        for (const dir of artifactsDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
      });

      it('writes a versioned manifest plus request/events/diff artifacts on a successful run', async () => {
        const ws = writeWorkspace();
        const artDir = writeArtifactsDir();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws, '--artifacts', artDir);

        expect(res.exited).toBe(false);
        expect(logged()).toContain('benchmark artifacts:');

        const manifestPath = join(artDir, 'manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.manifestVersion).toBe(1);
        expect(manifest.run.outcome).toBe('ready');
        expect(manifest.request.kind).toBe('local-brief');
        expect(manifest.phases.ship).toBe('skipped');

        expect(existsSync(join(artDir, 'request.json'))).toBe(true);
        expect(existsSync(join(artDir, 'events.ndjson'))).toBe(true);
        expect(existsSync(join(artDir, 'diff.patch'))).toBe(true);
      });

      it('writes a diagnosable manifest with a typed failure when CHECK fails', async () => {
        h.checkResult = {
          passed: false,
          summary: {
            failures: 1,
            passes: 0,
            skips: 0,
            total: 1,
            results: [{ checker: 'tests', result: 'FAIL', details: 'boom' }],
          },
          reworkRounds: 1,
        };
        const ws = writeWorkspace();
        const artDir = writeArtifactsDir();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws, '--artifacts', artDir);

        expect(res).toEqual({ exited: true, code: 1 });
        const manifestPath = join(artDir, 'manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.run.outcome).toBe('failed');
        expect(manifest.failure).toMatchObject({ phase: 'check', reason: 'fail' });
        expect(manifest.artifacts.events).toBe('events.ndjson');
      });

      it('exits 2 with --artifacts requires --workspace when --workspace is absent', async () => {
        const artDir = writeArtifactsDir();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--artifacts', artDir);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('--artifacts requires --workspace');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('exits 2 with invalid artifacts directory when the path is a regular file', async () => {
        const ws = writeWorkspace();
        const briefPath = writeBrief();
        const notADir = join(h.repoRoot, 'artifacts-file');
        writeFileSync(notADir, 'hello');

        const res = await runMain('run-brief', briefPath, '--workspace', ws, '--artifacts', notADir);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('invalid artifacts directory');
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('writes no manifest for normal runs (no --artifacts)', async () => {
        const briefPathA = writeBrief();
        const resA = await runMain('run-brief', briefPathA);
        expect(resA.exited).toBe(false);
        expect(logged()).not.toContain('benchmark artifacts:');

        const ws = writeWorkspace();
        const briefPathB = writeBrief();
        const resB = await runMain('run-brief', briefPathB, '--workspace', ws);
        expect(resB.exited).toBe(false);
        expect(logged()).not.toContain('benchmark artifacts:');
      });
    });
  });

  describe('git/github detection failures', () => {
    it('exits 2 with "not inside a git repository" when git rev-parse fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) throw new Error('fatal: not a git repository');
        return '';
      };
      const res = await runMain('status');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('not inside a git repository');
    });

    it('falls back to `gh auth token` via execSync when no GITHUB_TOKEN/GH_TOKEN env var is set', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.factoryConfig = { ...h.factoryConfig, filing: { selfFixLabel: 'no-auto-merge', enabled: false } };
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('gh auth token')) return 'gho_fallback_token\n';
        throw new Error('not stubbed');
      };
      const res = await runMain('land', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Landed PR #77');
    });
  });
});

// ===========================================================================
describe('CliExitError (direct command invocation)', () => {
  it('is a proper Error subclass carrying a code', () => {
    const err = new CliExitError('msg', 3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CliExitError');
    expect(err.message).toBe('msg');
    expect(err.code).toBe(3);
  });

  it('cmdConstitution({}) rejects with code 2 and the usage message', async () => {
    await expect(cmdConstitution({}, coreFakes)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringContaining('usage: factory constitution'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("cmdConstitution({ product: 'nope' }) rejects with code 1 and the not-found message", async () => {
    await expect(cmdConstitution({ product: 'nope' }, coreFakes)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 1,
      message: expect.stringContaining("No constitution 'nope'"),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdUsage() rejects with code 2 when FACTORY_USAGE_CAP is invalid', async () => {
    trackEnv('FACTORY_USAGE_CAP');
    process.env.FACTORY_USAGE_CAP = '-5';
    await expect(cmdUsage(coreFakes)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringContaining('FACTORY_USAGE_CAP'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdUsage() prints the real subscription usage plus the heuristic comparison when the subscription signal is available', async () => {
    h.subscriptionUsage = { fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' };
    await cmdUsage(coreFakes);
    const logged = logSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(logged).toContain('5h subscription usage: 42% of plan limit, resets 2026-07-15T18:00:00Z');
    expect(logged).toContain('heuristic list-price estimate: USAGE REPORT');
  });

  it('cmdUsage() falls back to the heuristic with a warning when the subscription signal is unavailable', async () => {
    h.subscriptionUsage = null;
    await cmdUsage(coreFakes);
    const logged = logSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(logged).toContain('real subscription usage unavailable');
    expect(logged).toContain('USAGE REPORT');
  });
});

// ===========================================================================
describe('parseIssueArg rejects unsafe integers across commands', () => {
  it.each([['ship'], ['run-issue'], ['queue', 'add', 'default'], ['reset']])(
    "'%s 9007199254740993' exits 2 before any GitHub work",
    async (...args) => {
      const res = await runMain(...args, '9007199254740993');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain("invalid issue argument '9007199254740993'");
      expect(errored()).toContain('expected a positive integer issue number');
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(h.octokit.rest.pulls.list).not.toHaveBeenCalled();
    },
  );
});

// ===========================================================================
describe('parseIssueArg wired into ship/land/local-small-dry-run', () => {
  it.each(['ship', 'land', 'local-small-dry-run'])(
    "'%s abc' fails before any GitHub or git work runs",
    async (command) => {
      const res = await runMain(command, 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain("invalid issue argument 'abc'");
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(h.octokit.rest.pulls.list).not.toHaveBeenCalled();
    },
  );
});

// ===========================================================================
describe('factory --help layout', () => {
  async function topLevelHelp(): Promise<string> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const written: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const res = await runMain('--help');
      expect(res.exited).toBe(true);
    } finally {
      process.stdout.write = originalWrite;
    }
    return written.join('');
  }

  /** Command names listed under one heading, up to the next blank line. */
  function section(help: string, heading: string): string[] {
    const start = help.indexOf(`${heading}\n`);
    expect(start, `missing heading ${heading}`).toBeGreaterThanOrEqual(0);
    const body = help.slice(start + heading.length + 1).split('\n\n')[0];
    return body
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0].split('|')[0])
      .filter((name) => /^[a-z]/.test(name));
  }

  it('shows every group heading in table order, with no catch-all section', async () => {
    const help = await topLevelHelp();
    const positions = HELP_GROUPS.map((g) => help.indexOf(`${g.heading}\n`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(help).not.toContain(`${OTHER_GROUP}\n`);
    expect(help).not.toContain('Commands:\n');
  });

  it("lists each group's commands under its heading, in table order", async () => {
    const help = await topLevelHelp();
    for (const group of HELP_GROUPS) {
      const expected = group.includesHelp ? [...group.commands, 'help'] : [...group.commands];
      expect(section(help, group.heading)).toEqual(expected);
    }
  });

  it('puts run-issue, ship, run, and land under "Run work:"', async () => {
    const runWork = section(await topLevelHelp(), 'Run work:');
    expect(runWork).toEqual(expect.arrayContaining(['run-issue', 'ship', 'run', 'land']));
  });

  it('says ship opens a PR and never merges, and run-issue is ship with an up-front issue check', async () => {
    const help = (await topLevelHelp()).replace(/\s+/g, ' ');
    expect(help).toContain('open a ready-for-review PR; never merges (merge later with land)');
    expect(help).toContain('Like ship, but loads the issue first');
  });
});

describe('ghRepoViewFailureMessage (#2592)', () => {
  it.each([undefined, '', 'no git remotes found'])('keeps the no-remote message for %j', (stderr) => {
    expect(ghRepoViewFailureMessage(stderr)).toBe('factory: no GitHub remote detected (gh repo view failed)');
  });

  it('keeps the no-remote message when no remote points to a known GitHub host (#2594)', () => {
    const msg = ghRepoViewFailureMessage(
      'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n',
    );
    expect(msg).toBe('factory: no GitHub remote detected (gh repo view failed)');
    expect(msg).not.toContain('gh is not authenticated');
  });

  it('names gh authentication when gh says it is logged out', () => {
    const msg = ghRepoViewFailureMessage(
      'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
    );
    expect(msg).toContain('gh is not authenticated');
    expect(msg).toContain('`gh auth login`');
    expect(msg).not.toContain('no GitHub remote detected');
  });

  it.each([
    'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login',
    'non-200 OK status code: 401 Unauthorized body: ...',
  ])('says the token was rejected and names the repo scope for %j', (stderr) => {
    const msg = ghRepoViewFailureMessage(stderr);
    expect(msg).toContain('rejected the token');
    expect(msg).toContain('`repo` scope');
    expect(msg).not.toContain('no GitHub remote detected');
    expect(msg).not.toContain('gh is not authenticated');
  });
});
