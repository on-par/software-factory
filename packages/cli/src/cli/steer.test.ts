// packages/cli/src/cli/steer.test.ts — `factory steer` resolution, validation and append (#3401)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readIssueRunState,
  runStateFile,
  writeIssueRunState,
  type IssueRunState,
  type RunStatus,
} from '@on-par/factory-core/internal';
import { getFactoryPaths, workKeyFromIssue } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliExitError, main } from './index.js';
import {
  cmdSteer,
  parseSteerRef,
  phaseForStatus,
  runSteer,
  SteerCliError,
  type SteerDeps,
  type SteerRuntime,
} from './steer.js';

const tmp = createTempDirs();
let dir: string;
let deps: SteerDeps;
const TS = '2026-10-21T12:00:00.000Z';

const fixture = (status: RunStatus = 'building'): IssueRunState => ({
  issue: 42,
  lane: 'bugfix',
  repo: 'o/r',
  status,
  branch: 'factory/42-x',
  worktree: dir,
  specPath: join(dir, 'spec.md'),
  model: 'm',
  route: 'claude',
  attempts: 1,
  startedAt: '2026-10-21T10:00:00.000Z',
  updatedAt: '2026-10-21T10:00:00.000Z',
  prNumber: 7,
});

const file = () => runStateFile(dir, workKeyFromIssue(42));

beforeEach(async () => {
  dir = await tmp.make('steer-');
  deps = { runsDir: dir, now: () => TS, defaultActor: () => 'patrick' };
  await writeIssueRunState(file(), fixture());
});
afterEach(() => tmp.cleanup());

describe('runSteer', () => {
  it('appends one cli steer with the message as summary to the issue run', async () => {
    await runSteer('42', { message: ' use the new API ' }, deps);
    expect((await readIssueRunState(file()))?.steers).toEqual([
      { ts: TS, actor: 'patrick', source: 'cli', phase: 'build', summary: 'use the new API' },
    ]);
    await runSteer('#42', { message: 'again' }, deps);
    expect((await readIssueRunState(file()))?.steers).toHaveLength(2);
  });

  it('stores source bot and the given actor', async () => {
    await runSteer('42', { message: 'x', source: 'bot', actor: 'renovate[bot]', unblocked: true }, deps);
    expect((await readIssueRunState(file()))?.steers).toEqual([
      { ts: TS, actor: 'renovate[bot]', source: 'bot', phase: 'build', summary: 'x', unblocked: true },
    ]);
  });

  it.each([
    'https://github.com/o/r/pull/7',
    'https://github.com/O/R/pull/7#x',
    'https://www.GitHub.com/o/r/pull/7?x=1#issuecomment-1',
    '7',
  ])('resolves PR reference %s to the run with that prNumber', async (ref) => {
    const result = await runSteer(ref, { message: 'x' }, deps);
    expect(result.issue).toBe(42);
    expect((await readIssueRunState(file()))?.steers).toHaveLength(1);
  });

  it.each([
    ['empty message', '42', { message: '' }, 'bad-input', '--message must not be empty'],
    ['whitespace message', '42', { message: '   ' }, 'bad-input', '--message must not be empty'],
    ['unknown source', '42', { message: 'x', source: 'slack' }, 'bad-input', "invalid --source 'slack'"],
    ['uppercase source', '42', { message: 'x', source: 'CLI' }, 'bad-input', "invalid --source 'CLI'"],
    ['bot without actor', '42', { message: 'x', source: 'bot' }, 'bad-input', '--source bot needs --actor'],
    [
      'bot with blank actor',
      '42',
      { message: 'x', source: 'bot', actor: ' ' },
      'bad-input',
      '--source bot needs --actor',
    ],
    ['unknown phase', '42', { message: 'x', phase: 'deploy' }, 'bad-input', "invalid --phase 'deploy'"],
    ['non-numeric ref', 'abc', { message: 'x' }, 'bad-input', 'invalid reference'],
    ['zero ref', '0', { message: 'x' }, 'bad-input', 'invalid reference'],
    ['multi-line message', '42', { message: 'line1\nline2' }, 'bad-input', '--message must be one line'],
    ['CRLF message', '42', { message: 'line1\r\nline2' }, 'bad-input', '--message must be one line'],
    ['gitlab URL', 'https://gitlab.com/x/y/issues/42', { message: 'x' }, 'bad-input', 'invalid reference'],
    [
      'other-repo URL, no such PR',
      'https://github.com/c/d/pull/999',
      { message: 'x' },
      'bad-input',
      'reference is for c/d',
    ],
    ['unmatched issue', '999', { message: 'x' }, 'no-run', 'no run found for 999'],
    ['unmatched PR', 'https://github.com/o/r/pull/999', { message: 'x' }, 'no-run', 'no run found'],
  ])('rejects bad input and unmatched refs without touching the run file: %s', async (_n, ref, opts, code, text) => {
    const before = await readFile(file(), 'utf8');
    const err = await runSteer(ref, opts, deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SteerCliError);
    expect((err as SteerCliError).code).toBe(code);
    expect((err as SteerCliError).message).toContain(text);
    expect(await readFile(file(), 'utf8')).toBe(before);
  });

  it('rejects a PR URL from another repo', async () => {
    await writeIssueRunState(file(), { ...fixture(), repo: 'a/b', prNumber: 2 });
    const before = await readFile(file(), 'utf8');
    const err = await runSteer('https://github.com/c/d/pull/2', { message: 'x' }, deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SteerCliError);
    expect((err as SteerCliError).code).toBe('bad-input');
    expect((err as SteerCliError).message).toContain('reference is for c/d, this repo is a/b');
    expect(await readFile(file(), 'utf8')).toBe(before);
  });

  it('rejects a non-URL string ending in /pull/2', async () => {
    await writeIssueRunState(file(), { ...fixture(), repo: 'a/b', prNumber: 2 });
    const before = await readFile(file(), 'utf8');
    await expect(runSteer('not a url at all /pull/2', { message: 'x' }, deps)).rejects.toMatchObject({
      code: 'bad-input',
    });
    expect(await readFile(file(), 'utf8')).toBe(before);
  });

  it('accepts a github.com URL when the run has no repo', async () => {
    await writeIssueRunState(file(), { ...fixture(), repo: undefined });
    await runSteer('https://github.com/any/where/pull/7', { message: 'x' }, deps);
    expect((await readIssueRunState(file()))?.steers).toHaveLength(1);
  });

  it('keeps a trailing-newline message as one line', async () => {
    await runSteer('42', { message: 'x\n' }, deps);
    expect((await readIssueRunState(file()))?.steers?.[0]?.summary).toBe('x');
  });

  it('asks for --phase when the run status has no phase', async () => {
    await writeIssueRunState(file(), fixture('parked'));
    await expect(runSteer('42', { message: 'x' }, deps)).rejects.toMatchObject({ code: 'bad-input' });
    await runSteer('42', { message: 'x', phase: 'check' }, deps);
    expect((await readIssueRunState(file()))?.steers?.[0]?.phase).toBe('check');
  });

  it('returns no-run when the runs dir does not exist', async () => {
    await expect(runSteer('42', { message: 'x' }, { ...deps, runsDir: join(dir, 'missing') })).rejects.toMatchObject({
      code: 'no-run',
    });
    await expect(runSteer('7', { message: 'x' }, { ...deps, runsDir: join(dir, 'missing') })).rejects.toMatchObject({
      code: 'no-run',
    });
  });
});

describe('phaseForStatus', () => {
  it.each([
    ['pending', 'plan'],
    ['planning', 'plan'],
    ['building', 'build'],
    ['reworking', 'build'],
    ['checking', 'check'],
    ['shipping', 'ship'],
    ['ready', 'ship'],
    ['awaiting-review', 'ship'],
    ['merged', 'ship'],
    ['parked', null],
    ['escalated', null],
    ['failed', null],
  ] as const)('%s -> %s', (status, phase) => {
    expect(phaseForStatus(status)).toBe(phase);
  });
});

describe('parseSteerRef', () => {
  it.each([
    ['#42', 'any', 42],
    ['42', 'any', 42],
  ] as const)('parses %s', (raw, kind, number) => {
    expect(parseSteerRef(raw)).toEqual({ kind, number, raw });
  });

  it.each([
    ['https://github.com/o/r/issues/42', 'issue', 42],
    ['https://github.com/o/r/pull/42/', 'pr', 42],
    ['https://www.GitHub.com/O/R/pull/7#issuecomment-1', 'pr', 7],
  ] as const)('parses URL %s', (raw, kind, number) => {
    expect(parseSteerRef(raw)).toEqual({ kind, number, raw, repo: 'o/r' });
  });

  it.each([
    '',
    'abc',
    '0',
    '-3',
    '#',
    '1.5',
    '99999999999999999999',
    'https://gitlab.com/x/y/issues/7',
    'not a url at all /pull/2',
    'github.com/o/r/pull/2',
    'https://github.com/o/pull/2',
    'https://github.com/o/r/pull/2/files',
    'ftp://github.com/o/r/pull/2',
    'https://github.com/o/r/pull/0',
  ])('rejects %j', (raw) => {
    expect(() => parseSteerRef(raw)).toThrow(SteerCliError);
  });
});

describe('cmdSteer runtime wiring', () => {
  let root: string;
  let lines: string[];
  let rt: SteerRuntime;
  const rootFile = () => runStateFile(getFactoryPaths(root).runs, workKeyFromIssue(42));

  beforeEach(async () => {
    root = await tmp.make('steer-repo-');
    await writeIssueRunState(rootFile(), fixture());
    lines = [];
    rt = {
      getRepoRoot: vi.fn(async () => root),
      gitUserName: async () => ' Pat \n',
      env: { USER: 'pat-user' },
      now: () => TS,
      CliExitError,
      errorDetail: (err) => (err instanceof Error ? err.message : String(err)),
      log: (line) => lines.push(line),
    };
  });

  it('records the steer under <repo>/.factory/state/runs with the git user as actor', async () => {
    await cmdSteer('42', { message: 'x' }, rt);
    expect((await readIssueRunState(rootFile()))?.steers).toEqual([
      { ts: TS, actor: 'Pat', source: 'cli', phase: 'build', summary: 'x' },
    ]);
    expect(lines).toEqual(['factory: steer recorded on #42 (source cli, phase build, actor Pat)']);
  });

  it('falls back to $USER, then unknown, when git has no user.name', async () => {
    rt.gitUserName = async () => {
      throw new Error('no user.name');
    };
    await cmdSteer('42', { message: 'x' }, rt);
    rt.env = {};
    rt.gitUserName = async () => '  ';
    await cmdSteer('42', { message: 'y' }, rt);
    expect((await readIssueRunState(rootFile()))?.steers?.map((s) => s.actor)).toEqual(['pat-user', 'unknown']);
  });

  it('exits 2 on bad input before any git lookup, 1 on no run, 1 with detail otherwise', async () => {
    await expect(cmdSteer('abc', { message: 'x' }, rt)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringContaining('factory: steer — invalid reference'),
    });
    expect(rt.getRepoRoot).not.toHaveBeenCalled();
    await expect(cmdSteer('999', { message: 'x' }, rt)).rejects.toMatchObject({
      code: 1,
      message: 'factory: steer — no run found for 999',
    });
    rt.getRepoRoot = async () => {
      throw new Error('not a git repo');
    };
    await expect(cmdSteer('42', { message: 'x' }, rt)).rejects.toMatchObject({
      code: 1,
      message: 'factory: steer failed — not a git repo',
    });
  });

  it('exits 2 for a URL from another repo', async () => {
    await expect(cmdSteer('https://github.com/c/d/pull/7', { message: 'x' }, rt)).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining('reference is for c/d'),
    });
  });

  it('is wired into the CLI entry point', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    try {
      await main(['node', 'factory', 'steer', 'abc', '--message', 'x']);
      expect(process.exitCode).toBe(2);
      expect(errSpy.mock.calls.flat().join('\n')).toContain("factory: steer — invalid reference 'abc'");
    } finally {
      process.exitCode = undefined;
      errSpy.mockRestore();
    }
  });
});
