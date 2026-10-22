// packages/cli/src/cli/ship-outcomes.test.ts — Ship flow (direct) tests: escalation, failures, proxy and environment outcomes (#2789)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { IssueDecomposedError, LaneParkError } from './index.js';
import { coreFakes, h, installShipHarness, logged, paths, phases, shipIssue } from './test-support/ship-harness.js';

installShipHarness();

describe('shipIssue (direct)', () => {
  const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo });

  it('throws a LaneParkError with reason escalate when the plan escalates', async () => {
    h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({ reason: 'escalate' });
  });

  it('emits exactly one escalate event for the issue outside local-only mode', async () => {
    h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({ reason: 'escalate' });
    const events = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const escalateEvents = events.filter((e: any) => e.type === 'escalate' && e.issue === '5');
    expect(escalateEvents).toHaveLength(1);
  });

  it('rewrites the queue entry and throws IssueDecomposedError (not a park) when the plan decomposed the issue', async () => {
    writeFileSync(paths().queue, 'app 5\n');
    h.planResult = { ok: false, route: 'claude', escalate: 'decomposed', decomposed: { childIssues: [10, 11] } };

    const err = await shipIssue(5, {}, ctx()).catch((e) => e);

    expect(err).toBeInstanceOf(IssueDecomposedError);
    expect(err.childIssues).toEqual([10, 11]);
    expect(readFileSync(paths().queue, 'utf-8')).toBe('app 10\napp 11\n');
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('queue entry for #5 replaced with #10, #11');
    expect(events).not.toContain('"type":"escalate"');
    expect(events).not.toContain('"type":"fail"');
  });

  it('logs decompose_filed without rewriting when the decomposed issue has no queue entry', async () => {
    h.planResult = { ok: false, route: 'claude', escalate: 'decomposed', decomposed: { childIssues: [10, 11] } };

    await expect(shipIssue(5, {}, ctx())).rejects.toBeInstanceOf(IssueDecomposedError);

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('#5 had no queue entry to replace — continuing the lane with #10, #11');
  });

  it('logs decompose_file_failed but still throws IssueDecomposedError when the queue rewrite errors', async () => {
    mkdirSync(paths().queue); // a directory at the queue path makes readFileSync throw
    h.planResult = { ok: false, route: 'claude', escalate: 'decomposed', decomposed: { childIssues: [10] } };

    await expect(shipIssue(5, {}, ctx())).rejects.toBeInstanceOf(IssueDecomposedError);

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('decompose_file_failed');
    expect(events).toContain('queue rewrite for #5 failed');
  });

  it('carries the CHECK failure signature and failing checks on the LaneParkError', async () => {
    h.checkResult = {
      passed: false,
      summary: { results: [{ checker: 'tests', result: 'FAIL', details: 'x' }], failures: 1 },
      reworkRounds: 0,
      failureSignature: 'sig-1',
    };
    const err = await shipIssue(5, {}, ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(LaneParkError);
    expect(err.failureSignature).toBe('sig-1');
    expect(err.failingChecks).toEqual(['tests']);
    expect(err.outcome.failureSignature).toBe('sig-1');
  });

  it('leaves the failure signature undefined for a non-CHECK park', async () => {
    h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
    const err = await shipIssue(5, {}, ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(LaneParkError);
    expect(err.failureSignature).toBeUndefined();
    expect(err.failingChecks).toBeUndefined();
  });

  it('throws a LaneParkError with reason escalate when the build escalates', async () => {
    h.buildResult = { ok: false, escalate: 'stuck' };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({ reason: 'escalate' });
  });

  it('throws a LaneParkError with reason fail when the ship phase fails', async () => {
    h.shipResult = { ok: false };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({ reason: 'fail' });
  });

  it('throws a LaneParkError with reason escalate and the denial message when ship is denied', async () => {
    h.shipResult = { ok: false, denied: true, deniedReason: 'not today' };
    await expect(shipIssue(5, {}, ctx())).rejects.toMatchObject({
      reason: 'escalate',
      message: 'ship denied: not today',
    });
  });

  it('does not construct an approval gate when interactive is not requested', async () => {
    await shipIssue(5, {}, ctx());
    const call = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
    expect(call.approvalGate).toBeUndefined();
    expect(call.checkSummary).toBe(h.checkResult.summary);
  });

  it('constructs an approval gate when interactive:true is passed', async () => {
    await shipIssue(5, { interactive: true }, ctx());
    const call = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
    expect(typeof call.approvalGate).toBe('function');
  });

  it('does not construct a plan approval gate when approvePlan is not requested', async () => {
    await shipIssue(5, {}, ctx());
    const call = phases.planPhase.mock.calls.at(-1)?.[0] as any;
    expect(call.approvalGate).toBeUndefined();
    expect(call.drainSteering).toBeUndefined();
  });

  it('constructs a plan approval gate when approvePlan:true is passed', async () => {
    await shipIssue(5, { approvePlan: true }, ctx());
    const call = phases.planPhase.mock.calls.at(-1)?.[0] as any;
    expect(typeof call.approvalGate).toBe('function');
    expect(typeof call.drainSteering).toBe('function');

    mkdirSync(paths().steering, { recursive: true });
    writeFileSync(
      join(paths().steering, 'issue-5.ndjson'),
      `${JSON.stringify({ id: 'steer-3', issue: 5, text: 'use provider X', queuedAt: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    const drained = call.drainSteering();
    expect(drained.messages).toEqual([
      { id: 'steer-3', issue: 5, text: 'use provider X', queuedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('passes an onPgid callback to buildPhase and checkPhase', async () => {
    await shipIssue(5, {}, ctx());
    const buildCall = phases.buildPhase.mock.calls.at(-1)?.[0] as any;
    const checkCall = phases.checkPhase.mock.calls.at(-1)?.[0] as any;
    expect(typeof buildCall.onPgid).toBe('function');
    expect(typeof checkCall.onPgid).toBe('function');
  });

  it('passes an onActivity callback to checkPhase that bumps the persisted phase snapshot heartbeat (#1326)', async () => {
    await shipIssue(5, {}, ctx());

    const checkCall = phases.checkPhase.mock.calls.at(-1)?.[0] as any;
    expect(typeof checkCall.onActivity).toBe('function');

    const snapshotFile = join(paths().state, 'runs', 'issue-5.phase.json');
    const before = JSON.parse(readFileSync(snapshotFile, 'utf-8'));

    await checkCall.onActivity();

    const after = JSON.parse(readFileSync(snapshotFile, 'utf-8'));
    expect(Date.parse(after.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(before.lastActivityAt));
    expect(after.issue).toBe(before.issue);
    expect(after.phase).toBe(before.phase);
  });

  it('updates the persisted phase snapshot lastEvent on every logged event (#1327)', async () => {
    await shipIssue(5, {}, ctx());

    const checkCall = phases.checkPhase.mock.calls.at(-1)?.[0] as any;
    expect(typeof checkCall.log).toBe('function');

    const snapshotFile = join(paths().state, 'runs', 'issue-5.phase.json');
    checkCall.log('build', 'a custom test event');

    await vi.waitFor(() => {
      const after = JSON.parse(readFileSync(snapshotFile, 'utf-8'));
      expect(after.lastEvent).toBe('build: a custom test event');
    });
  });

  it('tracks a pgid reported through onPgid and sweeps it before releasing the lease, without crashing the run', async () => {
    phases.buildPhase.mockImplementationOnce(async (opts) => {
      // An already-dead pgid: exercises the track -> killAll path without touching a real process group.
      opts.onPgid?.(999999999);
      return h.buildResult;
    });

    const branch = await shipIssue(5, {}, ctx());
    expect(branch).toBe('factory/5-fix-the-bug');
  });

  it('does not log environment_cleanup when no process groups were tracked', async () => {
    await shipIssue(5, {}, ctx());
    expect(logged()).not.toContain('environment_cleanup');
  });

  it('runs the orphan reaper over a reaped stale lease and logs each event', async () => {
    const portsFile = join(h.repoRoot, '.factory', 'state', 'ports.json');
    writeFileSync(
      portsFile,
      JSON.stringify({
        version: 1,
        leases: [
          {
            worktreeId: '/dead/worktree',
            branch: 'gone',
            port: 4002,
            pid: 2 ** 30,
            acquiredAt: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    h.orphanEvents = [
      { action: 'killed', worktreeId: '/dead/worktree', port: 4002, pid: 111, pgid: 222, command: 'node server.js' },
    ];

    await shipIssue(5, {}, ctx());

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('environment_lease_reaped');
    expect(events).toContain('environment_orphan');
    expect(events).toContain(
      'killed pid 111 (pgid 222, node server.js) squatting port 4002 of dead lane /dead/worktree',
    );
  });

  it('reports a busy-but-unleased port as a conflict without terminating anything', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const busyPort = (server.address() as any).port;

    h.factoryConfig = {
      ...h.factoryConfig,
      environment: { ...h.factoryConfig.environment, ports: { enabled: true, range: [busyPort, busyPort + 1] } },
    };
    h.portListeners = [{ pid: 777, pgid: 888, command: 'some-other-proc' }];

    try {
      await shipIssue(5, {}, ctx());
    } finally {
      server.close();
    }

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('environment_conflict');
    expect(events).toContain(`port ${busyPort} busy but unleased — reported as conflict, not terminated`);
    expect(events).toContain('pid 777 (some-other-proc)');
  });

  it('logs "no listener details available" when the conflict probe finds no listeners', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const busyPort = (server.address() as any).port;

    h.factoryConfig = {
      ...h.factoryConfig,
      environment: { ...h.factoryConfig.environment, ports: { enabled: true, range: [busyPort, busyPort + 1] } },
    };
    h.portListeners = [];

    try {
      await shipIssue(5, {}, ctx());
    } finally {
      server.close();
    }

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain(
      `port ${busyPort} busy but unleased — reported as conflict, not terminated: no listener details available`,
    );
  });

  it('logs environment_lease_failed when the conflict probe itself rejects and the range is exhausted', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const busyPort = (server.address() as any).port;

    h.factoryConfig = {
      ...h.factoryConfig,
      environment: { ...h.factoryConfig.environment, ports: { enabled: true, range: [busyPort, busyPort] } },
    };
    coreFakes.defaultFindPortListeners.mockRejectedValueOnce(new Error('lsof unavailable'));

    try {
      await shipIssue(5, {}, ctx());
    } finally {
      server.close();
    }

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain(`port ${busyPort} busy but unleased — reported as conflict, not terminated`);
    expect(events).toContain('environment_lease_failed');
    expect(events).toContain('port lease unavailable');
  });

  it('logs that port leasing is disabled when environment.ports.enabled is false', async () => {
    h.factoryConfig = {
      ...h.factoryConfig,
      environment: { ...h.factoryConfig.environment, ports: { enabled: false, range: [3100, 3999] } },
    };

    await shipIssue(5, {}, ctx());

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('port leasing disabled (environment.ports.enabled=false or FACTORY_ENV_PORTS=0)');
  });

  it('resolves and logs a stable lane URL from the factory proxy when leasing and the proxy are both enabled and running', async () => {
    h.factoryConfig = {
      ...h.factoryConfig,
      environment: {
        ...h.factoryConfig.environment,
        ports: { enabled: true, range: [20100, 20150] },
        proxy: { enabled: true, port: 80, domain: 'factory.localhost' },
      },
    };
    writeFileSync(
      join(paths().state, 'proxy.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 80,
        domain: 'factory.localhost',
        startedAt: new Date().toISOString(),
      }),
    );

    await shipIssue(5, {}, ctx());

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('stable lane URL http://');
    expect(events).toContain('.factory.localhost -> 127.0.0.1:');
  });

  it('logs a port-based note when the proxy is enabled but not running', async () => {
    h.factoryConfig = {
      ...h.factoryConfig,
      environment: {
        ...h.factoryConfig.environment,
        ports: { enabled: true, range: [20200, 20250] },
        proxy: { enabled: true, port: 80, domain: 'factory.localhost' },
      },
    };

    await shipIssue(5, {}, ctx());

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('environment_proxy_unavailable');
    expect(events).toContain('proxy enabled but not running — using http://127.0.0.1:');
  });
});
