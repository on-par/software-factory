// src/daemon/engine-supervisor.test.ts — Pins the factoryd engine-supervision
// contract (#1178): staleness measured from the engine event stream, in-process
// restart past the threshold, exactly one observable 'engine-restarted' event
// per restart, and — the hard guarantee — a restart writes nothing to the
// managed repo's .factory/ except that event append (no queue snapshot/backup).

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readEvents } from '../events/index.js';
import { EVENT_TRAITS } from '../events/kinds.js';
import {
  superviseActiveRepos,
  superviseEngine,
  type EngineRunner,
  type EngineSupervisor,
} from './engine-supervisor.js';
import type { RepoRegistry, RepoRegistryListing } from './registry.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function mktempTracked(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-engine-supervisor-'));
  tmpDirs.push(dir);
  return dir;
}

function entryFor(slug: string, path: string, overrides: Partial<RepoRegistryListing> = {}): RepoRegistryListing {
  return { slug, path, attachedAt: '2026-09-01T00:00:00.000Z', state: 'active', ...overrides };
}

function fakeRunner(): { handles: Array<{ stopped: boolean }>; runEngine: EngineRunner } {
  const handles: Array<{ stopped: boolean }> = [];
  const runEngine: EngineRunner = () => {
    const record = { stopped: false };
    handles.push(record);
    return {
      done: new Promise<void>(() => {}),
      stop: async () => {
        record.stopped = true;
      },
    };
  };
  return { handles, runEngine };
}

async function stopTracked(supervisor: EngineSupervisor): Promise<void> {
  await supervisor.stop();
}

describe('superviseEngine', () => {
  it('does not restart a fresh engine (recent event-stream activity)', async () => {
    const stateRoot = await mktempTracked();
    let clock = 1_000_000;
    const { handles, runEngine } = fakeRunner();
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 500,
      now: () => clock,
      lastEventAt: async () => clock - 100,
    });

    supervisor.start();
    clock += 200;
    await expect(supervisor.checkNow()).resolves.toBe('fresh');
    expect(handles).toHaveLength(1);
    expect(supervisor.restarts()).toBe(0);
    await stopTracked(supervisor);
  });

  it('treats a just-started engine with no events yet as fresh (start-time floor)', async () => {
    const stateRoot = await mktempTracked();
    let clock = 1_000_000;
    const { handles, runEngine } = fakeRunner();
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 500,
      now: () => clock,
      lastEventAt: async () => null,
    });

    supervisor.start();
    clock += 100; // past start, well within threshold
    await expect(supervisor.checkNow()).resolves.toBe('fresh');
    expect(handles).toHaveLength(1);
    await stopTracked(supervisor);
  });

  it('stops and relaunches an engine whose event stream is stale past the threshold', async () => {
    const stateRoot = await mktempTracked();
    let clock = 1_000_000;
    const { handles, runEngine } = fakeRunner();
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 500,
      now: () => clock,
      lastEventAt: async () => 1_000_000,
    });

    supervisor.start();
    clock += 501;
    await expect(supervisor.checkNow()).resolves.toBe('restarted');
    expect(handles).toHaveLength(2);
    expect(handles[0]?.stopped).toBe(true);
    expect(handles[1]?.stopped).toBe(false);
    expect(supervisor.restarts()).toBe(1);

    // startedAt was reset by the relaunch, so the same stale lastEventAt no
    // longer trips the threshold.
    await expect(supervisor.checkNow()).resolves.toBe('fresh');
    expect(supervisor.restarts()).toBe(1);
    await stopTracked(supervisor);
  });

  it('detects staleness through the default lastEventAt (events-file mtime)', async () => {
    const stateRoot = await mktempTracked();
    await mkdir(join(stateRoot, 'state'), { recursive: true });
    await writeFile(join(stateRoot, 'state', 'events.ndjson'), '{"type":"build"}\n');
    let clock = Date.now();
    const { handles, runEngine } = fakeRunner();
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 60_000,
      now: () => clock,
    });

    supervisor.start();
    await expect(supervisor.checkNow()).resolves.toBe('fresh');
    clock += 61_000;
    await expect(supervisor.checkNow()).resolves.toBe('restarted');
    expect(handles).toHaveLength(2);
    await stopTracked(supervisor);
  });

  it('publishes exactly one engine-restarted event into the engine event stream', async () => {
    const stateRoot = await mktempTracked();
    let clock = 1_000_000;
    const { runEngine } = fakeRunner();
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 500,
      now: () => clock,
      lastEventAt: async () => 1_000_000,
    });

    supervisor.start();
    clock += 501;
    await expect(supervisor.checkNow()).resolves.toBe('restarted');

    const restartEvents = readEvents(supervisor.context.paths.events).filter((e) => e.type === 'engine-restarted');
    expect(restartEvents).toHaveLength(1);
    expect(restartEvents[0]?.lane).toBe('acme/widgets');
    expect(restartEvents[0]?.issue).toBe('acme/widgets');
    expect(restartEvents[0]?.actor).toBe('factoryd');
    expect(restartEvents[0]?.msg).toContain('restarted in-process');
    expect(EVENT_TRAITS['engine-restarted']).toEqual({ severity: 'warn', isPark: false, isTerminal: false });
    await stopTracked(supervisor);
  });

  it('writes nothing on restart except the event append — no queue snapshot under .factory/', async () => {
    const repoRoot = await mktempTracked();
    const factoryDir = join(repoRoot, '.factory');
    const queueDir = join(factoryDir, 'state', 'queue');
    await mkdir(queueDir, { recursive: true });
    const issueBody = '# Issue 7\n\ndo the thing\n';
    await writeFile(join(queueDir, 'issue-7.md'), issueBody);
    await writeFile(join(factoryDir, 'state', 'queue.proposed'), 'issue-9\n');

    let clock = 1_000_000;
    const { runEngine } = fakeRunner();
    // No stateRoot: the checkout-local `.factory/` fallback is exactly the tree
    // the acceptance criteria say must stay clean.
    const supervisor = superviseEngine(entryFor('acme/widgets', repoRoot), runEngine, {
      staleThresholdMs: 500,
      now: () => clock,
      lastEventAt: async () => 1_000_000,
    });

    const before = (await readdir(factoryDir, { recursive: true })).sort();
    supervisor.start();
    clock += 501;
    await expect(supervisor.checkNow()).resolves.toBe('restarted');
    const after = (await readdir(factoryDir, { recursive: true })).sort();

    const added = after.filter((path) => !before.includes(path));
    expect(added).toEqual([join('state', 'events.ndjson')]);
    expect(after.filter((path) => !added.includes(path))).toEqual(before);
    expect(added.some((path) => path.includes('queue'))).toBe(false);
    await expect(readFile(join(queueDir, 'issue-7.md'), 'utf-8')).resolves.toBe(issueBody);
    await expect(readFile(join(factoryDir, 'state', 'queue.proposed'), 'utf-8')).resolves.toBe('issue-9\n');
    await stopTracked(supervisor);
  });

  it('still restarts when stopping the stale engine throws (logged, not fatal)', async () => {
    const stateRoot = await mktempTracked();
    let clock = 1_000_000;
    let calls = 0;
    const runEngine: EngineRunner = () => {
      calls += 1;
      const first = calls === 1;
      return {
        done: new Promise<void>(() => {}),
        stop: async () => {
          if (first) throw new Error('engine wedged');
        },
      };
    };
    const warnings: string[] = [];
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 500,
      now: () => clock,
      lastEventAt: async () => 1_000_000,
      log: (line) => warnings.push(line),
    });

    supervisor.start();
    clock += 501;
    await expect(supervisor.checkNow()).resolves.toBe('restarted');
    expect(calls).toBe(2);
    expect(warnings.some((line) => line.includes('engine wedged'))).toBe(true);
    await stopTracked(supervisor);
  });

  it('stop() halts supervision: engine stopped, no further restarts, start() is a no-op', async () => {
    const stateRoot = await mktempTracked();
    let clock = 1_000_000;
    const { handles, runEngine } = fakeRunner();
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 500,
      now: () => clock,
      lastEventAt: async () => 1_000_000,
    });

    supervisor.start();
    await supervisor.stop();
    expect(handles).toHaveLength(1);
    expect(handles[0]?.stopped).toBe(true);

    clock += 10_000; // far past the threshold — but supervision has ended
    await expect(supervisor.checkNow()).resolves.toBe('idle');
    supervisor.start();
    expect(handles).toHaveLength(1);
    expect(supervisor.restarts()).toBe(0);
  });

  it('does not relaunch when stop() lands during an in-flight staleness check', async () => {
    const stateRoot = await mktempTracked();
    let clock = 1_000_000;
    const { handles, runEngine } = fakeRunner();
    let release: (value: number) => void = () => {};
    const gate = new Promise<number>((resolve) => {
      release = resolve;
    });
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 500,
      now: () => clock,
      lastEventAt: () => gate,
    });

    supervisor.start();
    clock += 501;
    const pending = supervisor.checkNow(); // parked on the lastEventAt await
    await supervisor.stop();
    release(1_000_000); // now reads as stale — but supervision has ended
    await expect(pending).resolves.toBe('idle');
    expect(handles).toHaveLength(1);
    expect(supervisor.restarts()).toBe(0);
  });

  it('is idle before start()', async () => {
    const stateRoot = await mktempTracked();
    const { handles, runEngine } = fakeRunner();
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 500,
      lastEventAt: async () => null,
    });
    await expect(supervisor.checkNow()).resolves.toBe('idle');
    expect(handles).toHaveLength(0);
  });

  it('never raises an unhandled rejection when the engine done promise rejects', async () => {
    const stateRoot = await mktempTracked();
    const runEngine: EngineRunner = () => ({
      done: Promise.reject(new Error('crash')),
      stop: async () => {},
    });
    const supervisor = superviseEngine(entryFor('acme/widgets', '/tmp/acme-widgets', { stateRoot }), runEngine, {
      staleThresholdMs: 500,
    });

    supervisor.start();
    // Flush microtasks so an unswallowed rejection would surface and fail the
    // suite via vitest's unhandled-rejection detection.
    await Promise.resolve();
    await Promise.resolve();
    await stopTracked(supervisor);
  });
});

describe('superviseActiveRepos', () => {
  it('creates supervisors only for active registry entries', async () => {
    const stateRoot = await mktempTracked();
    const registry: RepoRegistry = {
      version: 1,
      repos: {
        'acme/active': { path: '/tmp/a', stateRoot, attachedAt: '2026-09-01T00:00:00.000Z', state: 'active' },
        'acme/paused': { path: '/tmp/b', stateRoot, attachedAt: '2026-09-01T00:00:00.000Z', state: 'paused' },
        'acme/draining': { path: '/tmp/c', stateRoot, attachedAt: '2026-09-01T00:00:00.000Z', state: 'draining' },
        'acme/detached': { path: '/tmp/d', stateRoot, attachedAt: '2026-09-01T00:00:00.000Z', state: 'detached' },
      },
    };
    const { handles, runEngine } = fakeRunner();

    const supervisors = superviseActiveRepos(registry, runEngine, { staleThresholdMs: 500 });
    expect([...supervisors.keys()]).toEqual(['acme/active']);
    expect(handles).toHaveLength(0); // callers own start()
  });
});
