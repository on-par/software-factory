import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { workKeyFromIssue } from '@on-par/factory-core';
import { runStateFile, writeIssueRunState, type IssueRunState } from '@on-par/factory-core/internal';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CliDeps } from './index.js';
import {
  errored,
  h,
  installCliCommandsHarness,
  logged,
  paths,
  runMainWith,
  trackEnv,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

const ISSUE = 5;
const PR = 41;
let ran: string[] = [];
let writes: string[] = [];

const runFile = () => runStateFile(paths().runs, workKeyFromIssue(ISSUE));

const writeRun = (extra: Partial<IssueRunState> = {}) =>
  writeIssueRunState(runFile(), {
    issue: ISSUE,
    lane: 'bugfix',
    repo: h.ghRepo,
    status: 'shipping',
    branch: 'factory/5-x',
    worktree: h.repoRoot,
    specPath: join(h.repoRoot, 'spec.md'),
    model: 'm',
    route: 'claude',
    attempts: 1,
    startedAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    prNumber: PR,
    ...extra,
  });

const recordingPhases: CliDeps = {
  buildPhase: async () => {
    ran.push('build');
    return h.buildResult;
  },
  checkPhase: async () => {
    ran.push('check');
    return h.checkResult;
  },
  shipPhase: async () => {
    ran.push('ship');
    return h.shipResult;
  },
};

const resume = (...args: string[]) => runMainWith(recordingPhases, 'resume', ...args);

const openPr = (open: boolean) => {
  h.octokit.rest.pulls.list = async ({ state }: { state: string }) => ({
    data:
      open && state === 'open'
        ? [{ number: PR, body: `Closes #${ISSUE}`, head: { ref: 'factory/5-x', sha: 'head5', repo: null } }]
        : [],
  });
};

const checks = (...runs: Array<[string, string | null, string | null]>) => {
  h.octokit.rest.checks.listForRef = async () => ({
    data: { check_runs: runs.map(([name, status, conclusion]) => ({ name, status, conclusion })) },
  });
};

beforeEach(() => {
  ran = [];
  writes = [];
});

const forbidWrites = () => {
  const forbid = (name: string) => async () => {
    writes.push(name);
    throw new Error(`${name} must not run`);
  };
  Object.assign(h.octokit.rest.pulls, { merge: forbid('merge'), update: forbid('update'), create: forbid('create') });
  h.octokit.rest.git = {
    deleteRef: forbid('deleteRef'),
    createRef: forbid('createRef'),
    updateRef: forbid('updateRef'),
  };
};

const expectNoChange = (before: string) => {
  expect(readFileSync(runFile(), 'utf-8')).toBe(before);
  expect(ran).toEqual([]);
  expect(writes).toEqual([]);
};

describe('factory resume <issue> --from ci-rework', () => {
  beforeEach(() => {
    forbidWrites();
    h.octokit.rest.pulls.get = async () => ({ data: { head: { sha: 'head5' }, base: { ref: 'main' } } });
    openPr(true);
  });

  it('exits 0 with no change when the PR is green', async () => {
    await writeRun({ ciReworkRounds: { [String(PR)]: 2 } });
    const before = readFileSync(runFile(), 'utf-8');
    checks(['ci', 'completed', 'success'], ['lint', 'completed', 'skipped']);
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: false, code: undefined });
    expect(logged()).toContain(`PR #${PR} for #${ISSUE} is green; nothing to rework`);
    expectNoChange(before);
  });

  it('exits 0 with no change when the issue has no open PR and names the closed one', async () => {
    await writeRun();
    const before = readFileSync(runFile(), 'utf-8');
    openPr(false);
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: false, code: undefined });
    expect(logged()).toContain(`#${ISSUE} has no open PR (PR #${PR} is closed or merged); nothing to rework`);
    expectNoChange(before);
  });

  it('exits 0 when there is no open PR and no run state', async () => {
    openPr(false);
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: false, code: undefined });
    expect(logged()).toContain(`#${ISSUE} has no open PR; nothing to rework`);
    expect(existsSync(runFile())).toBe(false);
    expect(ran).toEqual([]);
  });

  it('exits 0 with no change while checks are still pending', async () => {
    await writeRun();
    const before = readFileSync(runFile(), 'utf-8');
    checks(['ci', 'in_progress', null]);
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: false, code: undefined });
    expect(logged()).toContain('has no failing checks yet; nothing to rework');
    expectNoChange(before);
  });

  it('refuses with exit 1 and a clear reason when the PR already used the default cap', async () => {
    await writeRun({ ciReworkRounds: { [String(PR)]: 2 } });
    const before = readFileSync(runFile(), 'utf-8');
    checks(['ci', 'completed', 'failure']);
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: true, code: 1 });
    expect(errored()).toContain(`PR #${PR} for #${ISSUE} already used 2 of 2 CI rework rounds`);
    expect(errored()).toContain('refusing another round (failing: ci)');
    expect(logged()).not.toContain('would rework');
    expectNoChange(before);
  });

  it('honours the configured cap from the environment', async () => {
    trackEnv('FACTORY_MAX_CI_REWORK_ROUNDS');
    process.env.FACTORY_MAX_CI_REWORK_ROUNDS = '1';
    await writeRun({ ciReworkRounds: { [String(PR)]: 1 } });
    checks(['ci', 'completed', 'failure']);
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: true, code: 1 });
    expect(errored()).toContain('already used 1 of 1 CI rework rounds');
  });

  it('accepts a failing PR with budget left as "would rework" with exit 3 and starts no round', async () => {
    await writeRun({ ciReworkRounds: { [String(PR)]: 1 } });
    const before = readFileSync(runFile(), 'utf-8');
    checks(['ci', 'completed', 'failure'], ['lint', 'completed', 'success']);
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: true, code: 3 });
    expect(logged()).toContain(`PR #${PR} for #${ISSUE} would rework: round 2 of 2 (failing: ci); no round started`);
    expectNoChange(before);
  });

  it('accepts a failing PR with no recorded rounds as round 1', async () => {
    checks(['ci', 'completed', 'timed_out']);
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: true, code: 3 });
    expect(logged()).toContain('would rework: round 1 of 2 (failing: ci)');
    expect(existsSync(runFile())).toBe(false);
    expect(ran).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe('factory resume <issue> --from check is unchanged', () => {
  it('still takes the kept-build path and ignores the PR and its checks', async () => {
    forbidWrites();
    checks(['ci', 'completed', 'failure']);
    expect(await resume(String(ISSUE), '--from', 'check')).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain(`no preserved build for #${ISSUE}`);
    expect(logged()).not.toContain('would rework');
    expect(ran).toEqual([]);
    expect(writes).toEqual([]);
  });

  it.each([['build'], ['ship']])('exits 2 for the unsupported phase %j and names both phases', async (phase) => {
    writeFileSync(paths().stop, '');
    expect(await resume(String(ISSUE), '--from', phase)).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('only supports --from check or --from ci-rework');
    expect(existsSync(paths().stop)).toBe(true);
    expect(ran).toEqual([]);
  });

  it('exits 2 for --from ci-rework with an invalid issue', async () => {
    expect(await resume('abc', '--from', 'ci-rework')).toEqual({ exited: true, code: 2 });
    expect(ran).toEqual([]);
  });
});
