// packages/cli/src/cli/ship-sandbox.test.ts — Ship flow (direct) tests: local-only reports, sandbox and steering (#2789)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  coreFakes,
  h,
  installShipHarness,
  logged,
  paths,
  phases,
  setupWorktree,
  shipIssue,
  trackEnv,
} from './test-support/ship-harness.js';

installShipHarness();

describe('shipIssue (direct)', () => {
  const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo });

  it('writes a local-only run report on success when FACTORY_LOCAL_ONLY=1', async () => {
    trackEnv('FACTORY_LOCAL_ONLY');
    process.env.FACTORY_LOCAL_ONLY = '1';
    await shipIssue(5, {}, ctx());
    expect(coreFakes.writeLocalRunReport).toHaveBeenCalled();
    expect(logged()).toContain('local-only report');
  });

  it('writes a failed local-only run report and logs the park reason on error', async () => {
    trackEnv('FACTORY_LOCAL_ONLY');
    process.env.FACTORY_LOCAL_ONLY = '1';
    h.checkResult = {
      passed: false,
      summary: { results: [], failures: 1 },
      reworkRounds: 0,
      failureSignature: 'sig-1',
    };
    await expect(shipIssue(5, {}, ctx())).rejects.toBeTruthy();
    const report = coreFakes.writeLocalRunReport.mock.calls.at(-1)?.[0] as any;
    expect(report.outcome).toBe('failed');
  });

  it('logs sandbox-disabled by config when factory.json sandbox.enabled is false', async () => {
    h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, enabled: false } };
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('sandbox disabled by config/FACTORY_SANDBOX');
  });

  it('sets the Codex task allowlist from config even when OS containment is disabled', async () => {
    h.factoryConfig = {
      ...h.factoryConfig,
      sandbox: { ...h.factoryConfig.sandbox, enabled: false, codexFullAccessTasks: ['build_codex'] },
    };
    await shipIssue(5, {}, ctx());
    const router = vi.mocked(coreFakes.ModelRouter).mock.results.at(-1)?.value;
    expect(router.setCodexFullAccessTasks).toHaveBeenCalledWith(['build_codex']);
  });

  it('passes the docker-sandbox descriptor to setupWorktree without a speculative sandbox log when sandbox.runtime is docker-sandbox', async () => {
    h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, runtime: 'docker-sandbox' } };
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    // createMicroVm (not the CLI) owns the outcome-driven 'sandbox'/'sandbox-unavailable'
    // events; setupWorktree is an injected double here, so neither fires — the CLI must not log a
    // premature "active" event before the microVM actually exists.
    expect(events).not.toContain('docker-sandbox microVM active for lane');
    expect(vi.mocked(setupWorktree).mock.calls.at(-1)?.[4]).toEqual(
      expect.objectContaining({ runtime: 'docker-sandbox' }),
    );
  });

  it('activates the sandbox policy and logs the degraded-egress warning when a sandbox runtime is available', async () => {
    h.execSyncImpl = (cmd: string) => {
      if (cmd.includes('command -v sandbox-exec') || cmd.includes('command -v firejail')) return '/usr/bin/tool';
      throw new Error('not stubbed');
    };
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('sandbox-degraded');
    expect(events).toContain('host-level egress filtering unavailable');
    expect(events).not.toContain('sandbox-unavailable');
  });

  it('passes the resolved state root into the outer sandbox for PLAN', async () => {
    h.factoryConfig = {
      ...h.factoryConfig,
      sandbox: { ...h.factoryConfig.sandbox, runtime: 'sandbox-exec', network: { allow: [] } },
    };
    await shipIssue(5, {}, ctx());
    expect(phases.planPhase.mock.calls.at(-1)?.[0].sandbox?.writablePaths).toContain(paths().state);
  });

  describe('report-only egress proxy (#2214)', () => {
    const refused = (port: number): Promise<string> =>
      new Promise((res) => {
        const sock = connect(port, '127.0.0.1');
        sock.on('connect', () => {
          sock.destroy();
          res('connected');
        });
        sock.on('error', (e: NodeJS.ErrnoException) => res(e.code ?? 'error'));
      });

    beforeEach(() => {
      h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, runtime: 'sandbox-exec' } };
    });

    it('passes proxyUrl to the build phase, logs egress_summary, and closes the proxy', async () => {
      let port = 0;
      phases.buildPhase.mockImplementationOnce(async (opts) => {
        const url = opts.sandbox!.proxyUrl!;
        port = Number(new URL(url).port);
        expect(await refused(port)).toBe('connected');
        return h.buildResult;
      });
      await shipIssue(5, {}, ctx());
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('egress_summary');
      expect(port).toBeGreaterThan(0);
      expect(await refused(port)).toBe('ECONNREFUSED');
    });

    it('closes the proxy when the build phase throws', async () => {
      let port = 0;
      phases.buildPhase.mockImplementationOnce(async (opts) => {
        port = Number(new URL(opts.sandbox!.proxyUrl!).port);
        throw new Error('build blew up');
      });
      await expect(shipIssue(5, {}, ctx())).rejects.toThrow();
      expect(port).toBeGreaterThan(0);
      expect(await refused(port)).toBe('ECONNREFUSED');
      expect(readFileSync(paths().events, 'utf-8')).toContain('egress_summary');
    });
  });

  it('stamps the resolved sandboxRuntime and running reworkRoundCount onto each cost row (#655)', async () => {
    h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, runtime: 'docker-sandbox' } };
    h.checkResult = { passed: true, summary: { results: [], failures: 0 }, reworkRounds: 2 };

    await shipIssue(5, {}, ctx());

    const costs = readFileSync(paths().costs, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(costs).toHaveLength(1);
    expect(costs[0].sandboxRuntime).toBe('docker-sandbox');
    expect(costs[0].reworkRoundCount).toBe(2);
  });

  it('stamps workspaceBackend "worktree" onto each cost row when workspace.backend is unset (#1532)', async () => {
    await shipIssue(5, {}, ctx());

    const costs = readFileSync(paths().costs, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(costs).toHaveLength(1);
    expect(costs[0].workspaceBackend).toBe('worktree');
  });

  it('stamps workspaceBackend "disposable-docker" onto each cost row when workspace.backend is disposable-docker (#1532)', async () => {
    h.factoryConfig = { ...h.factoryConfig, workspace: { backend: 'disposable-docker' } };

    await shipIssue(5, {}, ctx());

    const costs = readFileSync(paths().costs, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(costs).toHaveLength(1);
    expect(costs[0].workspaceBackend).toBe('disposable-docker');
  });

  it('logs skip-ci when FACTORY_SKIP_CI resolves to true', async () => {
    await shipIssue(5, {}, ctx(), { resolveSkipCI: () => true });
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('skip-ci');
    expect(events).toContain('skipping CI watch');
  });

  it('logs unconsumed steering when interactive leftover messages remain after ship', async () => {
    // Queue a fresh steering message as a side effect of shipPhase — after the
    // build-time drain but before shipIssue's post-ship leftover check.
    phases.shipPhase.mockImplementationOnce(async () => {
      mkdirSync(paths().steering, { recursive: true });
      writeFileSync(
        join(paths().steering, 'issue-5.ndjson'),
        `${JSON.stringify({ id: 'steer-late', issue: 5, text: 'too late', queuedAt: '2026-01-01T00:00:00.000Z' })}\n`,
      );
      return h.shipResult;
    });
    await shipIssue(5, { interactive: true }, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('steering_unconsumed');
  });

  describe('steering', () => {
    function writeQueuedSteering() {
      mkdirSync(paths().steering, { recursive: true });
      writeFileSync(
        join(paths().steering, 'issue-5.ndjson'),
        `${JSON.stringify({ id: 'steer-1', issue: 5, text: 'prefer approach B', queuedAt: '2026-01-01T00:00:00.000Z' })}\n`,
      );
    }

    it('drains queued steering into buildPhase and logs steering_applied when interactive', async () => {
      writeQueuedSteering();

      await shipIssue(5, { interactive: true }, ctx());

      const buildCall = phases.buildPhase.mock.calls.at(-1)?.[0] as any;
      expect(buildCall.steering.messages).toEqual([
        { id: 'steer-1', issue: 5, text: 'prefer approach B', queuedAt: '2026-01-01T00:00:00.000Z' },
      ]);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('steering_applied');
      expect(existsSync(join(paths().steering, 'issue-5.ndjson'))).toBe(false);
    });

    it('passes a drainSteering callback to checkPhase that drains the same issue steering queue', async () => {
      await shipIssue(5, { interactive: true }, ctx());

      const checkCall = phases.checkPhase.mock.calls.at(-1)?.[0] as any;
      expect(typeof checkCall.drainSteering).toBe('function');

      mkdirSync(paths().steering, { recursive: true });
      writeFileSync(
        join(paths().steering, 'issue-5.ndjson'),
        `${JSON.stringify({ id: 'steer-2', issue: 5, text: 'follow up guidance', queuedAt: '2026-01-01T00:00:00.000Z' })}\n`,
      );

      const drained = checkCall.drainSteering();
      expect(drained.messages).toEqual([
        { id: 'steer-2', issue: 5, text: 'follow up guidance', queuedAt: '2026-01-01T00:00:00.000Z' },
      ]);
    });

    it('does not drain steering, and passes steering: undefined, when not interactive', async () => {
      writeQueuedSteering();

      await shipIssue(5, {}, ctx());

      const buildCall = phases.buildPhase.mock.calls.at(-1)?.[0] as any;
      expect(buildCall.steering).toBeUndefined();
      const checkCall = phases.checkPhase.mock.calls.at(-1)?.[0] as any;
      expect(checkCall.drainSteering).toBeUndefined();
      expect(existsSync(join(paths().steering, 'issue-5.ndjson'))).toBe(true);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).not.toContain('steering_applied');
    });
  });
});
