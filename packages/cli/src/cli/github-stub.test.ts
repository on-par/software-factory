import { exec as execCb } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { GITHUB_ISSUE_SOURCE, createDefaultWorkSourceRegistry, shipPhase } from '@on-par/factory-core';
import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_STUB_CALLS_FILE,
  GITHUB_STUB_FIXTURE_FILE,
  createStubOctokit,
  recordGitPushes,
  resolveGitHubMode,
  selectOctokit,
} from './github-stub.js';

const exec = promisify(execCb);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'github-stub-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

const writeFixture = (dir: string, fixture: unknown) =>
  writeFileSync(join(dir, GITHUB_STUB_FIXTURE_FILE), JSON.stringify(fixture));
const readCalls = (dir: string) =>
  readFileSync(join(dir, GITHUB_STUB_CALLS_FILE), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { op: string; args: any; at: string });

describe('resolveGitHubMode', () => {
  it('is real when unset or empty', () => {
    expect(resolveGitHubMode({})).toBe('real');
    expect(resolveGitHubMode({ FACTORY_GITHUB: '' })).toBe('real');
  });
  it('is stub for stub in any case or padding', () => {
    expect(resolveGitHubMode({ FACTORY_GITHUB: 'stub' })).toBe('stub');
    expect(resolveGitHubMode({ FACTORY_GITHUB: ' STUB ' })).toBe('stub');
  });
  it('fails closed on unknown values', () => {
    expect(() => resolveGitHubMode({ FACTORY_GITHUB: 'real' })).toThrow(/FACTORY_GITHUB/);
    expect(() => resolveGitHubMode({ FACTORY_GITHUB: 'stbu' })).toThrow(/FACTORY_GITHUB/);
  });
});

describe('selectOctokit', () => {
  it('calls the real factory when unset', () => {
    const client = {} as Octokit;
    const real = vi.fn(() => client);
    expect(selectOctokit({}, real)).toBe(client);
    expect(real).toHaveBeenCalledTimes(1);
  });
  it('never calls the real factory in stub mode', () => {
    const real = vi.fn();
    selectOctokit({ FACTORY_GITHUB: 'stub', FACTORY_GITHUB_STUB_DIR: tmp }, real);
    expect(real).not.toHaveBeenCalled();
  });
  it('requires FACTORY_GITHUB_STUB_DIR in stub mode', () => {
    const real = vi.fn();
    expect(() => selectOctokit({ FACTORY_GITHUB: 'stub' }, real)).toThrow(/FACTORY_GITHUB_STUB_DIR/);
    expect(real).not.toHaveBeenCalled();
  });
});

describe('createStubOctokit', () => {
  it('serves issues and labels from fixture.json', async () => {
    writeFixture(tmp, { issues: { '7': { title: 'T', body: 'B', labels: ['a'] } }, labels: ['a', 'b'] });
    const o = createStubOctokit(tmp);
    const { data } = await o.rest.issues.get({ owner: 'o', repo: 'r', issue_number: 7 });
    expect(data).toMatchObject({ title: 'T', body: 'B', state: 'open', labels: [{ name: 'a' }] });
    expect((await o.rest.issues.listLabelsOnIssue({ owner: 'o', repo: 'r', issue_number: 7 })).data).toEqual([
      { name: 'a' },
    ]);
    expect((await o.rest.issues.listLabelsForRepo({ owner: 'o', repo: 'r' })).data).toEqual([
      { name: 'a' },
      { name: 'b' },
    ]);
    expect((await o.rest.issues.listComments({ owner: 'o', repo: 'r', issue_number: 7 })).data).toEqual([]);
    expect((await o.rest.checks.listForRef({ owner: 'o', repo: 'r', ref: 'x' })).data.total_count).toBe(0);
  });

  it('rejects a missing issue with status 404, and treats a missing fixture as empty', async () => {
    const o = createStubOctokit(tmp);
    await expect(o.rest.issues.get({ owner: 'o', repo: 'r', issue_number: 1 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(o.rest.issues.listLabelsOnIssue({ owner: 'o', repo: 'r', issue_number: 1 })).rejects.toMatchObject({
      status: 404,
    });
    expect((await o.rest.issues.listLabelsForRepo({ owner: 'o', repo: 'r' })).data).toEqual([]);
  });

  it('appends each write as a JSONL line', async () => {
    const o = createStubOctokit(tmp, { now: () => new Date('2026-01-01T00:00:00Z') });
    await o.rest.issues.addLabels({ owner: 'o', repo: 'r', issue_number: 1, labels: ['x'] });
    await o.rest.issues.createComment({ owner: 'o', repo: 'r', issue_number: 1, body: 'hi' });
    await o.rest.issues.removeLabel({ owner: 'o', repo: 'r', issue_number: 1, name: 'x' });
    await o.rest.issues.setLabels({ owner: 'o', repo: 'r', issue_number: 1, labels: [] });
    await o.rest.issues.update({ owner: 'o', repo: 'r', issue_number: 1, state: 'closed' });
    await o.rest.pulls.update({ owner: 'o', repo: 'r', pull_number: 1, title: 't' });
    const created = await o.rest.issues.create({ owner: 'o', repo: 'r', title: 't' });
    expect(created.data.number).toBeGreaterThan(0);
    await (o as any).graphql('mutation {}', { id: 'x' });
    const calls = readCalls(tmp);
    expect(calls.map((c) => c.op)).toEqual([
      'issues.addLabels',
      'issues.createComment',
      'issues.removeLabel',
      'issues.setLabels',
      'issues.update',
      'pulls.update',
      'issues.create',
      'graphql',
    ]);
    expect(calls[0]).toMatchObject({ args: { labels: ['x'] }, at: '2026-01-01T00:00:00.000Z' });
  });

  it('finds created PRs through pulls.list and pulls.get', async () => {
    const o = createStubOctokit(tmp);
    const base = { owner: 'o', repo: 'r' };
    const { data } = await o.rest.pulls.create({ ...base, head: 'b', base: 'main', title: 'T', draft: true });
    expect(data.number).toBe(1);
    const found = await o.rest.pulls.list({ ...base, head: 'o:b', state: 'open' });
    expect(found.data).toHaveLength(1);
    expect(found.data[0]).toMatchObject({ number: 1, head: { ref: 'b' }, draft: true });
    expect((await o.rest.pulls.list({ ...base, head: 'o:other', state: 'all' })).data).toEqual([]);
    expect((await o.rest.pulls.list({ ...base, head: 'o:b', state: 'closed' })).data).toEqual([]);
    expect((await o.rest.pulls.get({ ...base, pull_number: 1 })).data).toMatchObject({ title: 'T' });
    expect((await o.rest.pulls.get({ ...base, pull_number: 9 })).data).toMatchObject({ draft: true });
  });

  it('honours firstPrNumber', async () => {
    writeFixture(tmp, { firstPrNumber: 40 });
    const o = createStubOctokit(tmp);
    const { data } = await o.rest.pulls.create({ owner: 'o', repo: 'r', head: 'b', base: 'main', title: 'T' });
    expect(data.number).toBe(40);
  });

  it('rejects unserved endpoints by name', async () => {
    const o = createStubOctokit(tmp);
    await expect(o.rest.repos.get({ owner: 'o', repo: 'r' })).rejects.toThrow(/not served by the GitHub stub/);
    await expect(o.rest.pulls.merge({ owner: 'o', repo: 'r', pull_number: 1 })).rejects.toThrow(
      /rest\.pulls\.merge is not served/,
    );
    await expect(o.request('GET /x')).rejects.toThrow(/FACTORY_GITHUB=stub/);
    await expect((o.paginate as any)()).rejects.toThrow(/paginate/);
  });

  it('names the path of a malformed fixture', async () => {
    writeFileSync(join(tmp, GITHUB_STUB_FIXTURE_FILE), '{nope');
    const o = createStubOctokit(tmp);
    await expect(o.rest.issues.get({ owner: 'o', repo: 'r', issue_number: 1 })).rejects.toThrow(
      new RegExp(GITHUB_STUB_FIXTURE_FILE),
    );
    await expect(o.rest.issues.get({ owner: 'o', repo: 'r', issue_number: 1 })).rejects.toHaveProperty(
      'cause',
      expect.any(SyntaxError),
    );
  });
});

describe('recordGitPushes', () => {
  it('records only git push commands and always delegates', async () => {
    const callsFile = join(tmp, GITHUB_STUB_CALLS_FILE);
    const inner = vi.fn(async () => ({ stdout: 'ok' }));
    const run = recordGitPushes(inner, callsFile, 'br');
    await run('git status');
    expect(existsSync(callsFile)).toBe(false);
    await expect(run('git push -u origin br', { cwd: '/w' })).resolves.toEqual({ stdout: 'ok' });
    expect(inner).toHaveBeenCalledTimes(2);
    expect(readCalls(tmp)).toMatchObject([
      { op: 'git.push', args: { branch: 'br', command: 'git push -u origin br', cwd: '/w' } },
    ]);
  });
});

describe('offline ship', () => {
  const branch = 'factory/7-offline';

  async function shipOffline() {
    const origin = join(tmp, 'origin.git');
    const worktree = join(tmp, 'work');
    const stubDir = join(tmp, 'stub');
    const g = `git -C '${worktree}'`;
    await exec(`git init --bare -b main '${origin}'`);
    await exec(`git init -b main '${worktree}'`);
    await exec(`${g} config user.email t@t && ${g} config user.name t`);
    await exec(`${g} remote add origin '${origin}'`);
    writeFileSync(join(worktree, 'a.txt'), 'a');
    await exec(`${g} add -A && ${g} commit -m init && ${g} push -u origin main`);
    await exec(`${g} checkout -b ${branch}`);
    writeFileSync(join(worktree, 'b.txt'), 'b');
    await exec(`${g} add -A && ${g} commit -m change`);

    const dir = stubDir;
    await exec(`mkdir -p '${dir}'`);
    writeFixture(dir, { issues: { '7': { title: 'Offline ship', body: 'b', labels: ['factory'] } } });
    vi.stubEnv('FACTORY_GITHUB', 'stub');
    vi.stubEnv('FACTORY_GITHUB_STUB_DIR', dir);
    const real = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const octokit = selectOctokit(process.env, real);

    const work = await createDefaultWorkSourceRegistry({ octokit }).resolve(GITHUB_ISSUE_SOURCE, {
      repo: 'o/r',
      issue: 7,
    } as never);
    const result = await shipPhase({
      issue: 7,
      repo: 'o/r',
      worktree,
      branch,
      octokit,
      watchCI: false,
      log: () => {},
      run: recordGitPushes(exec, join(dir, GITHUB_STUB_CALLS_FILE), branch),
    });
    return { work, result, real, fetchSpy, dir };
  }

  it('ships an issue offline from fixture to PR create without constructing a real client', async () => {
    const { work, result, real, fetchSpy, dir } = await shipOffline();
    expect((work as { title: string }).title).toBe('Offline ship');
    expect(result.ok).toBe(true);
    expect(typeof result.prNumber).toBe('number');
    expect(real).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readCalls(dir).some((c) => c.op === 'git.push' && c.args.branch === branch)).toBe(true);
  }, 30_000);

  it('records pulls.create with head branch and title in calls.jsonl', async () => {
    const { dir } = await shipOffline();
    const create = readCalls(dir).find((c) => c.op === 'pulls.create');
    expect(create?.args.head).toBe(branch);
    expect(create?.args.title).toBe('Offline ship (#7)');
  }, 30_000);
});
