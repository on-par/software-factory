// packages/cli/src/cli/daemon-status-json.test.ts — `factory daemon status --json` off macOS and its
// load snapshot (#3201); the helper units live here too.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadFactoryConfig, type FactoryConfig } from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cmdDaemonStatus, type DaemonCtlDeps, type LaunchctlExec } from './daemon.js';
import { readDaemonLoad, readDaemonPidFile } from './daemon-load.js';
import { daemonStatusJsonSchema } from './json-contract.js';

const RUNS_FIXTURE = [
  { run: { status: 'running' }, executionPid: 4242, log: '', truncated: false },
  { run: { status: 'running' }, executionPid: 9999, log: '', truncated: false },
  { run: { status: 'queued' }, log: '', truncated: false },
  { run: { status: 'queued' }, log: '', truncated: false },
];

function configWithSlots(maxAgentJobs: number): FactoryConfig {
  const base = loadFactoryConfig();
  return { ...base, host: { ...base.host, maxAgentJobs } };
}

describe('readDaemonPidFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-pid-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['abc', null],
    ['0', null],
    ['-5', null],
    ['', null],
    ['42\n', 42],
  ])('parses %j as %s', (content, expected) => {
    const f = join(dir, 'daemon.pid');
    writeFileSync(f, content);
    expect(readDaemonPidFile(f)).toBe(expected);
  });

  it('returns null for a missing file', () => {
    expect(readDaemonPidFile(join(dir, 'nope'))).toBeNull();
  });
});

describe('readDaemonLoad', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-load-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (content: string | undefined, loadConfig: () => FactoryConfig = () => configWithSlots(2)) => {
    const runsFile = join(dir, 'runs.json');
    if (content !== undefined) writeFileSync(runsFile, content);
    return readDaemonLoad({ runsFile, isPidAlive: (p) => p === 4242, loadConfig });
  };

  it('counts live execution pids and queued entries', () => {
    expect(run(JSON.stringify(RUNS_FIXTURE))).toEqual({ activeRuns: 1, queueDepth: 2, maxSlots: 2 });
  });

  it('ignores non-positive and non-integer pids and non-object entries', () => {
    const entries = [null, 'x', { executionPid: -1 }, { executionPid: 1.5 }, { run: null }, { executionPid: 4242 }];
    expect(run(JSON.stringify(entries))).toEqual({ activeRuns: 1, queueDepth: 0, maxSlots: 2 });
  });

  it.each([
    ['missing', undefined],
    ['malformed', '{'],
    ['not an array', '{}'],
  ])('%s runs.json → null counts', (_n, content) => {
    expect(run(content)).toEqual({ activeRuns: null, queueDepth: null, maxSlots: 2 });
  });

  it('a throwing loadConfig → maxSlots null', () => {
    expect(
      run('[]', () => {
        throw new Error('bad config');
      }),
    ).toEqual({ activeRuns: 0, queueDepth: 0, maxSlots: null });
  });
});

describe('daemon status --json load and non-darwin support (#3201)', () => {
  let home: string;
  let output: string;
  let calls: string[];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'daemon-status-json-'));
    mkdirSync(join(home, '.factory'), { recursive: true });
    output = '';
    calls = [];
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const exec: LaunchctlExec = (cmd) => {
    calls.push(cmd);
    return Promise.resolve({ code: cmd === 'ps' ? 0 : 113, stdout: cmd === 'ps' ? '00:02:03\n' : '', stderr: '' });
  };
  const run = (over: DaemonCtlDeps) =>
    cmdDaemonStatus(
      {
        exec,
        home,
        uid: 501,
        registryFile: join(home, '.factory', 'registry.json'),
        out: { write: (s) => (output += s) },
        isPidAlive: () => false,
        loadConfig: () => loadFactoryConfig(),
        ...over,
      },
      { json: true },
    );
  const writeRuns = (content: unknown) =>
    writeFileSync(join(home, '.factory', 'runs.json'), typeof content === 'string' ? content : JSON.stringify(content));

  it('daemon status --json reports running and load off macOS', async () => {
    writeFileSync(join(home, '.factory', 'daemon.pid'), '4242\n');
    writeRuns(RUNS_FIXTURE);
    await run({ platform: 'linux', isPidAlive: (p) => p === 4242, loadConfig: () => configWithSlots(3) });
    expect(daemonStatusJsonSchema.parse(JSON.parse(output))).toEqual({
      schemaVersion: 1,
      running: true,
      pid: 4242,
      uptimeSec: 123,
      plistInstalled: false,
      repos: [],
      load: { activeRuns: 1, queueDepth: 2, maxSlots: 3 },
    });
    expect(calls).toEqual(['ps']);
    expect(process.exitCode).not.toBe(1);
  });

  it('daemon status --json off macOS with no daemon.pid reports not running without launchctl', async () => {
    await run({ platform: 'linux' });
    expect(JSON.parse(output)).toMatchObject({ running: false, pid: null, uptimeSec: null, plistInstalled: false });
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('daemon status --json off macOS with a dead daemon.pid reports not running', async () => {
    writeFileSync(join(home, '.factory', 'daemon.pid'), '4242\n');
    await run({ platform: 'linux', isPidAlive: () => false });
    expect(JSON.parse(output)).toMatchObject({ running: false, pid: null, uptimeSec: null });
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('darwin output keeps every pre-#3201 field unchanged and adds load', async () => {
    const launchctl: LaunchctlExec = (cmd) =>
      Promise.resolve({ code: 0, stdout: cmd === 'launchctl' ? 'pid = 42' : '00:02:03', stderr: '' });
    await run({ platform: 'darwin', exec: launchctl });
    const { load, ...previous } = JSON.parse(output) as Record<string, unknown>;
    expect(load).toBeDefined();
    expect(previous).toEqual({
      schemaVersion: 1,
      running: true,
      pid: 42,
      uptimeSec: 123,
      plistInstalled: false,
      repos: [],
    });
  });

  it.each(['darwin', 'linux'] as const)('counts runs and slots on %s', async (platform) => {
    writeRuns(RUNS_FIXTURE);
    await run({ platform, isPidAlive: (p) => p === 4242, loadConfig: () => configWithSlots(3) });
    expect(daemonStatusJsonSchema.parse(JSON.parse(output)).load).toEqual({
      activeRuns: 1,
      queueDepth: 2,
      maxSlots: 3,
    });
  });

  it('unset maxAgentJobs → maxSlots 1; missing runs.json → null counts, exit follows running', async () => {
    await run({ platform: 'darwin' });
    expect(JSON.parse(output).load).toEqual({ activeRuns: null, queueDepth: null, maxSlots: 1 });
    expect(process.exitCode).toBe(1);
  });

  it('malformed runs.json → null counts; throwing loadConfig → null maxSlots', async () => {
    writeRuns('{');
    await run({
      platform: 'darwin',
      loadConfig: () => {
        throw new Error('bad config');
      },
    });
    expect(JSON.parse(output).load).toEqual({ activeRuns: null, queueDepth: null, maxSlots: null });
  });
});
