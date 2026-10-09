// src/checkers/flaky-rerun.ts — pure plan for a serial re-run of a failing tests checker (#2291)
import { extractFailingTestNames } from './baseline.js';
import type { TestsCommand } from './index.js';
import type { PackageJson } from './probe.js';

export const RERUN_TIMEOUT_MS = 600_000;

export interface RerunPlan {
  mode: 'targeted' | 'full';
  argv: string[];
  timeoutMs: number;
  /** Test identifiers the targeted argv selects; [] for a full re-run. */
  tests: string[];
}

function full(cmd: TestsCommand): RerunPlan {
  return { mode: 'full', argv: [...cmd.argv], timeoutMs: RERUN_TIMEOUT_MS, tests: [] };
}

function testNamePattern(name: string): string {
  const last = name.split(' > ').pop() ?? name;
  return last
    .replace(/\s+\d+(?:\.\d+)?ms$/, '')
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildRerunPlan(cmd: TestsCommand, pkg: PackageJson | null, details: string): RerunPlan {
  if (cmd.runner === 'pytest') {
    const ids = extractFailingTestNames(details).filter((n) => n.includes('::'));
    if (ids.length === 0) return full(cmd);
    return { mode: 'targeted', argv: ['python3', '-m', 'pytest', ...ids], timeoutMs: RERUN_TIMEOUT_MS, tests: ids };
  }
  if (cmd.runner === 'npm') {
    const script = pkg?.scripts?.test ?? '';
    const flag = /\bvitest\b/.test(script) ? '--no-file-parallelism' : /\bjest\b/.test(script) ? '--runInBand' : null;
    if (flag === null) return full(cmd);
    const names = [...new Set(extractFailingTestNames(details).map(testNamePattern).filter(Boolean))];
    if (names.length === 0) return full(cmd);
    return {
      mode: 'targeted',
      argv: ['npm', 'test', '--', '-t', names.join('|'), flag],
      timeoutMs: RERUN_TIMEOUT_MS,
      tests: names,
    };
  }
  return full(cmd);
}
