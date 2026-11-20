import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { workKeyFromIssue, type RunPorts } from '@on-par/factory-core';
import { readIssueRunState, runStateFile, writeIssueRunState, type IssueRunState } from '@on-par/factory-core/internal';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CliDeps } from './index.js';
import {
  errored,
  h,
  installCliCommandsHarness,
  logged,
  paths,
  runMainWith,
  tmp,
  trackEnv,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

const ISSUE = 5;
const PR = 41;
const BRANCH = 'factory/5-x';
const REWORK_COMMIT = 'fix the failing check';

type ShipPhase = NonNullable<RunPorts['shipPhase']>;
type ShipReply = Awaited<ReturnType<ShipPhase>>;
interface ShipEntry {
  branch: string;
  reentry?: { prNumber: number; previousHeadSha?: string };
  head: string;
}

let ran: string[] = [];
let writes: string[] = [];
let ships: ShipEntry[] = [];
let shipReplies: Array<(entry: ShipEntry, worktree: string) => ShipReply> = [];

const GIT_IDENTITY = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf-8' }).trim();

const runFile = () => runStateFile(paths().runs, workKeyFromIssue(ISSUE));

const writeRun = (extra: Partial<IssueRunState> = {}) =>
  writeIssueRunState(runFile(), {
    issue: ISSUE,
    lane: 'bugfix',
    repo: h.ghRepo,
    status: 'shipping',
    branch: BRANCH,
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
  planPhase: async () => {
    ran.push('plan');
    return h.planResult;
  },
  buildPhase: async () => {
    ran.push('build');
    return h.buildResult;
  },
  checkPhase: async () => {
    ran.push('check');
    return h.checkResult;
  },
  shipPhase: async (opts) => {
    ran.push('ship');
    const entry = { branch: opts.branch, reentry: opts.reentry, head: git(opts.worktree, 'rev-parse', 'HEAD') };
    ships.push(entry);
    const reply = shipReplies.shift();
    return reply ? reply(entry, opts.worktree) : h.shipResult;
  },
};

const resume = (...args: string[]) => runMainWith(recordingPhases, 'resume', ...args);

const prHeadRef = () => ({ ref: BRANCH, sha: 'head5', repo: { full_name: h.ghRepo } });

const openPr = (open: boolean) => {
  h.octokit.rest.pulls.list = async ({ state }: { state: string }) => ({
    data: open && state === 'open' ? [{ number: PR, body: `Closes #${ISSUE}`, head: prHeadRef() }] : [],
  });
};

const checks = (...runs: Array<[string, string | null, string | null]>) => {
  h.octokit.rest.checks.listForRef = async ({ ref }: { ref: string }) => ({
    data: {
      check_runs: ref === 'base' ? [] : runs.map(([name, status, conclusion]) => ({ name, status, conclusion })),
    },
  });
};

beforeEach(() => {
  ran = [];
  writes = [];
  ships = [];
  shipReplies = [];
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
    expect(logged()).not.toContain('starting CI rework round');
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
});

describe('factory resume <issue> --from ci-rework runs one round and returns to SHIP', () => {
  let origin = '';
  let prHead = '';

  const failingShip = (entry: ShipEntry): ShipReply => ({
    ok: false,
    prNumber: PR,
    reason: `CI failed for PR #${PR}`,
    ciOutcome: 'failure',
    ciFailure: { failingChecks: [{ name: 'ci', conclusion: 'failure' }], alerts: [], truncated: false },
    headSha: entry.head,
  });

  const pushingGreenShip = (entry: ShipEntry, worktree: string): ShipReply => {
    git(worktree, 'push', '-q', 'origin', `HEAD:${entry.branch}`);
    return { ok: true, prNumber: PR, ciOutcome: 'success', headSha: entry.head };
  };

  const seedOrigin = () => {
    origin = tmp.makeSync('factory-origin-');
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    const seed = tmp.makeSync('factory-seed-');
    git(seed, 'init', '-q', '-b', 'main');
    writeFileSync(join(seed, 'a.txt'), 'a\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'init');
    git(seed, 'checkout', '-q', '-b', BRANCH);
    writeFileSync(join(seed, 'b.txt'), 'b\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'work');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main', BRANCH);
    prHead = git(seed, 'rev-parse', 'HEAD');
  };

  const roundsOnDisk = async () => (await readIssueRunState(runFile()))?.ciReworkRounds?.[String(PR)];

  beforeEach(() => {
    seedOrigin();
    h.factoryConfig = { ...h.factoryConfig, worktree: { ...h.factoryConfig.worktree, parent: tmp.makeSync('wt-') } };
    h.setupWorktreeImpl = async (_repoRoot, branch, worktree) => {
      git(origin, 'clone', '-q', '-b', branch, origin, worktree);
    };
    h.routerRun = async (_task, _prompt, opts) => {
      writeFileSync(join(opts.worktree, 'fix.txt'), 'fixed\n');
      git(opts.worktree, 'add', '-A');
      git(opts.worktree, 'commit', '-q', '-m', REWORK_COMMIT);
      const result = { model: 'm', output: 'done', attempts: [] };
      return result;
    };
    h.octokit.rest.pulls.get = async () => ({ data: { head: { sha: 'head5' }, base: { ref: 'main' } } });
    h.octokit.rest.pulls.listFiles = async () => ({ data: [{ filename: 'b.txt' }] });
    openPr(true);
    checks(['ci', 'completed', 'failure'], ['lint', 'completed', 'success']);
    shipReplies = [failingShip, pushingGreenShip];
  });

  it('runs one recorded round on the PR branch, pushes it and finishes SHIP', async () => {
    await writeRun();
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: false, code: undefined });
    expect(logged()).toContain(`PR #${PR} for #${ISSUE} has failing checks (ci); starting CI rework round 1 of 2`);
    expect(logged()).toContain(`ran CI rework round 1 of 2, pushed ${BRANCH} and finished SHIP`);
    expect(ran).toEqual(['ship', 'check', 'ship']);
    expect(ships[0]).toEqual({ branch: BRANCH, reentry: { prNumber: PR }, head: prHead });
    expect(ships[1]?.reentry).toEqual({ prNumber: PR, previousHeadSha: prHead });
    expect(ships[1]?.head).not.toBe(prHead);
    expect(git(origin, 'log', '-1', '--format=%s', BRANCH)).toBe(REWORK_COMMIT);
    expect(git(origin, 'rev-parse', BRANCH)).toBe(ships[1]?.head);
    expect(await roundsOnDisk()).toBe(1);
    expect((await readIssueRunState(runFile()))?.status).toBe('ready');
  });

  it('exits 1 when CI is still red after the round and keeps the round recorded', async () => {
    shipReplies = [failingShip, failingShip];
    await writeRun();
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: true, code: 1 });
    expect(errored()).toContain(`CI rework resume of PR #${PR} for #${ISSUE} failed`);
    expect(ran).toEqual(['ship', 'check', 'ship']);
    expect(await roundsOnDisk()).toBe(1);
    expect((await readIssueRunState(runFile()))?.status).toBe('parked');
  });

  it('a fresh resume after the recorded round refuses at a cap of 1 and changes nothing', async () => {
    trackEnv('FACTORY_MAX_CI_REWORK_ROUNDS');
    process.env.FACTORY_MAX_CI_REWORK_ROUNDS = '1';
    await writeRun();
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: false, code: undefined });
    expect(logged()).toContain('ran CI rework round 1 of 1');
    expect(await roundsOnDisk()).toBe(1);
    const recorded = readFileSync(runFile(), 'utf-8');
    const shipped = [...ran];

    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: true, code: 1 });
    expect(errored()).toContain('already used 1 of 1 CI rework rounds; refusing another round');
    expect(readFileSync(runFile(), 'utf-8')).toBe(recorded);
    expect(ran).toEqual(shipped);
  });

  it('a fresh resume after the second recorded round refuses at the default cap', async () => {
    await writeRun({ ciReworkRounds: { [String(PR)]: 1 } });
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: false, code: undefined });
    expect(logged()).toContain('starting CI rework round 2 of 2');
    expect(logged()).toContain('ran CI rework round 2 of 2');
    expect(await roundsOnDisk()).toBe(2);
    const shipped = [...ran];

    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: true, code: 1 });
    expect(errored()).toContain('already used 2 of 2 CI rework rounds');
    expect(ran).toEqual(shipped);
  });
});

describe('factory resume <issue> --from ci-rework in a repo without .factory/', () => {
  const NOT_INITIALIZED = 'factory not initialized — run `factory init` first';

  beforeEach(() => {
    forbidWrites();
    h.octokit.rest.pulls.get = async () => ({ data: { head: { sha: 'head5' }, base: { ref: 'main' } } });
    openPr(true);
    checks(['ci', 'completed', 'failure']);
    rmSync(paths().root, { recursive: true, force: true });
  });

  it('refuses up front with exit 2 and the not-initialized message, touching nothing', async () => {
    expect(await resume(String(ISSUE), '--from', 'ci-rework')).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain(`factory: ${NOT_INITIALIZED}`);
    expect(logged()).not.toContain('CI rework round');
    expect(ran).toEqual([]);
    expect(writes).toEqual([]);
    expect(existsSync(paths().root)).toBe(false);
  });

  it('matches --from check, which refuses the same repo the same way', async () => {
    expect(await resume(String(ISSUE), '--from', 'check')).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain(`factory: ${NOT_INITIALIZED}`);
    expect(ran).toEqual([]);
    expect(existsSync(paths().root)).toBe(false);
  });
});

describe('factory resume <issue> --from check is unchanged', () => {
  it('still takes the kept-build path and ignores the PR and its checks', async () => {
    forbidWrites();
    checks(['ci', 'completed', 'failure']);
    expect(await resume(String(ISSUE), '--from', 'check')).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain(`no preserved build for #${ISSUE}`);
    expect(logged()).not.toContain('starting CI rework round');
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
