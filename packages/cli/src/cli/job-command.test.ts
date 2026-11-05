import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliExitError } from './errors.js';
import {
  cmdJob,
  createJobDeps,
  runJob,
  type JobCommandOptions,
  type JobDeps,
  type JobRunResult,
} from './job-command.js';
import { jobStatusJsonSchema, type JobStatusJson } from './job-status-contract.js';

const tempDirs = createTempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

const GH = 'ghp_SENTINEL';
const CLAUDE = 'sk-ant-SENTINEL';
const resultLine = (outcome: string): string =>
  JSON.stringify({
    schemaVersion: 3,
    issue: 7,
    repo: 'on-par/foreman',
    outcome,
    exitReason: `run ${outcome}`,
    pr: { number: 3, url: 'https://github.com/on-par/foreman/pull/3', state: 'merged' },
    branch: 'factory/7',
    baseSha: null,
    headSha: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    phases: [],
    cost: { usd: 0, byModel: {} },
    reworkRounds: 0,
  });

interface Harness {
  deps: JobDeps;
  calls: { cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[];
  stdout: string[];
  logs: string[];
  writes: { path: string; text: string; mode?: number }[];
  files: Set<string>;
}

function harness(
  child: Partial<JobRunResult> = { code: 0, stdout: resultLine('merged') },
  overrides: { files?: string[]; nonEmpty?: boolean; gitConfigSet?: boolean; env?: NodeJS.ProcessEnv } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const stdout: string[] = [];
  const logs: string[] = [];
  const writes: Harness['writes'] = [];
  const files = new Set(overrides.files ?? []);
  let clock = 0;
  const deps: JobDeps = {
    env: overrides.env ?? { GH_TOKEN: GH, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE, HOME: '/home/node' },
    run: (cmd, args, opts) => {
      calls.push({
        cmd,
        args,
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts.env === undefined ? {} : { env: opts.env }),
      });
      if (cmd === 'git' && args[0] === 'config' && args.length === 2) {
        return Promise.resolve({
          code: overrides.gitConfigSet ? 0 : 1,
          signal: null,
          stdout: overrides.gitConfigSet ? 'x\n' : '',
        });
      }
      if (cmd === 'node') return Promise.resolve({ code: 0, signal: null, stdout: '', ...child });
      return Promise.resolve({ code: 0, signal: null, stdout: '' });
    },
    exists: (p) => files.has(p),
    isNonEmptyDir: () => overrides.nonEmpty === true,
    mkdir: (p) => void files.add(p),
    writeFile: (path, text, mode) => {
      writes.push({ path, text, mode });
      files.add(path);
    },
    appendFile: (path, text) => void writes.push({ path, text }),
    now: () => (clock += 1000),
    stdout: (line) => void stdout.push(line),
    log: (line) => void logs.push(line),
    cliEntry: { node: 'node', script: '/cli.js' },
  };
  return { deps, calls, stdout, logs, writes, files };
}

const opts: JobCommandOptions = { repo: 'on-par/foreman', issue: '7', merge: true, workdir: '/work' };
const lastStatus = (h: Harness): JobStatusJson => jobStatusJsonSchema.parse(JSON.parse(h.stdout.at(-1) ?? '{}'));

describe('runJob', () => {
  it('clones the repo, runs run-issue --in-place --merge --json in the clone and exits with the child code', async () => {
    const h = harness();
    expect(await runJob(opts, h.deps)).toBe(0);
    expect(h.calls.map((c) => [c.cmd, ...c.args.slice(0, 2)])).toEqual([
      ['gh', 'auth', 'setup-git'],
      ['git', 'clone', 'https://github.com/on-par/foreman.git'],
      ['git', 'config', 'user.name'],
      ['git', 'config', 'user.name'],
      ['git', 'config', 'user.email'],
      ['git', 'config', 'user.email'],
      ['node', '/cli.js', 'run-issue'],
    ]);
    const child = h.calls.at(-1);
    expect(child?.args).toEqual(['/cli.js', 'run-issue', '7', '--in-place', '--json', '--merge']);
    expect(child?.cwd).toBe('/work/foreman');
    expect(child?.env?.FACTORY_CONFIG_PATH).toBe('/work/.factory-job/container-defaults.yaml');
    const exclude = h.writes.find((w) => w.path === '/work/foreman/.git/info/exclude');
    expect(exclude?.text).toBe('/.factory/state/\n/.factory/\n');
    expect(h.files.has('/work/foreman/.factory')).toBe(true);
    expect(h.logs).toContain(
      'factory job: config source: container defaults; constitution source: repo instruction files / bundled',
    );
    expect(h.writes.find((w) => w.path.endsWith('container-defaults.yaml'))?.mode).toBe(0o600);
  });

  it('sets the git identity only when unset and keeps a committed .factory out of the exclude list', async () => {
    const set = harness(undefined, { gitConfigSet: true, files: ['/work/foreman/.factory'] });
    await runJob(opts, set.deps);
    expect(set.calls.filter((c) => c.args.length === 3 && c.args[0] === 'config')).toHaveLength(0);
    expect(set.writes.find((w) => w.path.endsWith('info/exclude'))?.text).toBe('/.factory/state/\n');
    const unset = harness();
    await runJob(opts, unset.deps);
    expect(
      unset.calls.some((c) => c.args.join(' ') === 'config user.email factory-job[bot]@users.noreply.github.com'),
    ).toBe(true);
  });

  it('prints one final JSON status line with merged true, the PR url and timings', async () => {
    const h = harness();
    await runJob(opts, h.deps);
    expect(h.stdout).toHaveLength(1);
    const status = lastStatus(h);
    expect(status).toMatchObject({
      merged: true,
      outcome: 'merged',
      exitCode: 0,
      pr: { number: 3, url: 'https://github.com/on-par/foreman/pull/3' },
    });
    expect(status.timings.cloneMs).toBeGreaterThan(0);
    expect(status.timings.runMs).toBeGreaterThan(0);
  });

  it('writes ~/.claude.json with mode 0600 only when absent', async () => {
    const fresh = harness();
    await runJob(opts, fresh.deps);
    expect(fresh.writes.find((w) => w.path === '/home/node/.claude.json')).toEqual({
      path: '/home/node/.claude.json',
      text: '{"hasCompletedOnboarding":true}\n',
      mode: 0o600,
    });
    const existing = harness(undefined, { files: ['/home/node/.claude.json'] });
    await runJob(opts, existing.deps);
    expect(existing.writes.some((w) => w.path === '/home/node/.claude.json')).toBe(false);
  });

  it.each([0, 1, 11, 16])('propagates child exit code %i', async (code) => {
    const h = harness({ code, stdout: resultLine(code === 0 ? 'merged' : 'parked') });
    expect(await runJob(opts, h.deps)).toBe(code);
    expect(lastStatus(h).exitCode).toBe(code);
  });

  it('maps a signal to exit 1', async () => {
    const h = harness({ code: null, signal: 'SIGKILL', stdout: '' });
    expect(await runJob(opts, h.deps)).toBe(1);
    expect(lastStatus(h)).toMatchObject({ outcome: 'failed', exitReason: 'killed by SIGKILL' });
  });

  it('exits 2 when the child exits 0 without a valid result line', async () => {
    for (const stdout of ['', 'not json\n', '{"schemaVersion":1}\n']) {
      const h = harness({ code: 0, stdout });
      expect(await runJob(opts, h.deps)).toBe(2);
      expect(lastStatus(h).outcome).toBe('failed');
    }
  });

  it('keeps a non-zero child code even without a result line', async () => {
    const h = harness({ code: 12, stdout: '' });
    expect(await runJob(opts, h.deps)).toBe(12);
  });

  it('refuses an existing non-empty clone dir without deleting anything', async () => {
    const h = harness(undefined, { nonEmpty: true });
    expect(await runJob(opts, h.deps)).toBe(2);
    expect(h.calls.map((c) => c.cmd)).toEqual(['gh']);
    expect(lastStatus(h).exitReason).toContain('not empty');
  });

  it('exits 2 with a status line when GH_TOKEN or an agent token is missing', async () => {
    const h = harness(undefined, { env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE } });
    expect(await runJob(opts, h.deps)).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(lastStatus(h)).toMatchObject({ outcome: 'failed', exitCode: 2, repo: 'on-par/foreman', issue: 7 });
    expect(lastStatus(h).exitReason).toContain('GH_TOKEN');
    const bad = harness();
    expect(await runJob({ ...opts, repo: 'nope', issue: 'x' }, bad.deps)).toBe(2);
    expect(lastStatus(bad)).toMatchObject({ repo: 'nope', issue: 0 });
  });

  it('exits 2 when a setup command fails', async () => {
    const h = harness();
    const run = h.deps.run;
    h.deps.run = (cmd, args, o) =>
      cmd === 'gh' ? Promise.resolve({ code: 4, signal: null, stdout: '' }) : run(cmd, args, o);
    expect(await runJob(opts, h.deps)).toBe(2);
    expect(lastStatus(h).exitReason).toBe('gh auth setup-git failed (exit 4)');
  });

  it('reports unexpected setup errors without leaking their text', async () => {
    const h = harness();
    h.deps.run = () => Promise.reject(new Error(`token ${GH} leaked`));
    expect(await runJob(opts, h.deps)).toBe(2);
    expect(lastStatus(h).exitReason).toBe('unexpected setup error');
  });

  it('never writes token values to stdout, stderr or the status line', async () => {
    for (const child of [
      { code: 0, stdout: resultLine('merged') },
      { code: 1, stdout: 'x' },
    ]) {
      const h = harness(child);
      await runJob(opts, h.deps);
      const output = [...h.stdout, ...h.logs].join('\n');
      expect(output).not.toContain(GH);
      expect(output).not.toContain(CLAUDE);
    }
    const missing = harness(undefined, { env: { GH_TOKEN: GH } });
    await runJob(opts, missing.deps);
    expect([...missing.stdout, ...missing.logs].join('\n')).not.toContain(GH);
  });

  it('uses no shell: every spawn is a command plus an argument list', async () => {
    const h = harness();
    await runJob({ ...opts, repo: 'on-par/foreman' }, h.deps);
    expect(h.calls.every((c) => !['sh', 'bash'].includes(c.cmd) && !c.args.includes('-c'))).toBe(true);
  });
});

describe('runJob home fallback', () => {
  it('writes the onboarding state under the OS home when HOME is unset', async () => {
    const h = harness(undefined, { env: { GH_TOKEN: GH, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE } });
    expect(await runJob(opts, h.deps)).toBe(0);
    expect(h.writes.some((w) => w.path.endsWith('.claude.json'))).toBe(true);
  });
});

describe('createJobDeps', () => {
  it('runs commands with captured and inherited stdout and reports exit codes', async () => {
    const deps = createJobDeps();
    const captured = await deps.run(process.execPath, ['-e', 'console.log("hi")'], { captureStdout: true });
    expect(captured).toEqual({ code: 0, signal: null, stdout: 'hi\n' });
    const dir = tempDirs.makeSync('factory-job-deps-');
    const failed = await deps.run(process.execPath, ['-e', 'process.exit(3)'], { cwd: dir, env: { ...process.env } });
    expect(failed.code).toBe(3);
    await expect(deps.run('/nonexistent-binary-factory-job', [], {})).rejects.toThrow();
  });

  it('wraps the filesystem and output helpers', () => {
    const deps = createJobDeps();
    const dir = tempDirs.makeSync('factory-job-fs-');
    const nested = join(dir, 'a', 'b');
    expect(deps.isNonEmptyDir(nested)).toBe(false);
    deps.mkdir(nested);
    expect(deps.exists(nested)).toBe(true);
    expect(deps.isNonEmptyDir(nested)).toBe(false);
    const file = join(nested, 'f.txt');
    deps.writeFile(file, 'one\n', 0o600);
    deps.appendFile(file, 'two\n');
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(deps.isNonEmptyDir(nested)).toBe(true);
    expect(deps.now()).toBeGreaterThan(0);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    deps.stdout('line');
    deps.log('note');
    expect(out).toHaveBeenCalledWith('line\n');
    expect(err).toHaveBeenCalledWith('note\n');
    expect(deps.cliEntry.node).toBe(process.execPath);
  });
});

describe('cmdJob', () => {
  it('throws a silent CliExitError with the exit code and prints the status line', async () => {
    vi.stubEnv('GH_TOKEN', '');
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const err = await cmdJob({ repo: 'on-par/foreman', issue: '7' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).code).toBe(2);
    expect(String(out.mock.calls[0]?.[0])).toContain('"kind":"factory-job"');
  });
});
