// packages/cli/src/cli/steer.test.ts — `factory steer` resolution, validation and append (#3401)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readIssueRunState,
  runStateFile,
  writeIssueRunState,
  type IssueRunState,
  type RunStatus,
} from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSteerRef, phaseForStatus, runSteer, SteerCliError, type SteerDeps } from './steer.js';

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

const file = () => runStateFile(dir, 42);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steer-'));
  deps = { runsDir: dir, now: () => TS, defaultActor: () => 'patrick' };
  await writeIssueRunState(file(), fixture());
});
afterEach(() => rm(dir, { recursive: true, force: true }));

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

  it.each(['https://github.com/o/r/pull/7', '7'])(
    'resolves PR reference %s to the run with that prNumber',
    async (ref) => {
      const result = await runSteer(ref, { message: 'x' }, deps);
      expect(result.issue).toBe(42);
      expect((await readIssueRunState(file()))?.steers).toHaveLength(1);
    },
  );

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
    ['https://github.com/o/r/issues/42', 'issue', 42],
    ['https://github.com/o/r/pull/42/', 'pr', 42],
  ] as const)('parses %s', (raw, kind, number) => {
    expect(parseSteerRef(raw)).toEqual({ kind, number, raw });
  });

  it.each(['', 'abc', '0', '-3', '#', '1.5', '99999999999999999999'])('rejects %j', (raw) => {
    expect(() => parseSteerRef(raw)).toThrow(SteerCliError);
  });
});
