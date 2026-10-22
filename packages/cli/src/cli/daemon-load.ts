// packages/cli/src/cli/daemon-load.ts — read-only helpers behind `factory daemon status --json`
// (#3201): the daemon.pid reader and the load snapshot (activeRuns / maxSlots / queueDepth).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { daemonRuntimePaths, resolveHostMaxAgentJobs } from '@on-par/factory-core/internal';
import { getFactoryPaths, loadFactoryConfig, loadFactoryConfigForRepo, type FactoryConfig } from '@on-par/factory-core';

import type { DaemonLoadJson } from './json-contract.js';

export function defaultLoadConfig(): FactoryConfig {
  let root: string | null = null;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    root = null;
  }
  return root ? loadFactoryConfigForRepo(getFactoryPaths(root).config) : loadFactoryConfig();
}

/** Positive-integer pid from a daemon.pid file, or null when missing or malformed. */
export function readDaemonPidFile(pidFile: string): number | null {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number(raw);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The pid in `<home>/.factory/daemon.pid`, only if that process is alive (non-macOS status path). */
export function readLiveDaemonPid(home: string, isPidAlive: (pid: number) => boolean): number | null {
  const raw = readDaemonPidFile(daemonRuntimePaths(join(home, '.factory')).pidFile);
  return raw !== null && isPidAlive(raw) ? raw : null;
}

/** Read-only load snapshot for `daemon status --json`; any part that cannot be computed is null. */
export function readDaemonLoad(opts: {
  runsFile: string;
  isPidAlive: (pid: number) => boolean;
  loadConfig: () => FactoryConfig;
}): DaemonLoadJson {
  let activeRuns: number | null = null;
  let queueDepth: number | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(opts.runsFile, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('runs.json is not an array');
    let active = 0;
    let queued = 0;
    for (const entry of parsed as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { run, executionPid } = entry as { run?: { status?: unknown } | null; executionPid?: unknown };
      if (run?.status === 'queued') queued += 1;
      const hasPid = typeof executionPid === 'number' && Number.isInteger(executionPid) && executionPid > 0;
      if (hasPid && opts.isPidAlive(executionPid)) active += 1;
    }
    activeRuns = active;
    queueDepth = queued;
  } catch {
    activeRuns = null;
    queueDepth = null;
  }
  let maxSlots: number | null = null;
  try {
    maxSlots = resolveHostMaxAgentJobs(opts.loadConfig());
  } catch {
    maxSlots = null;
  }
  return { activeRuns, maxSlots, queueDepth };
}
