import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdJob, runJob, type JobDeps, type JobRunResult } from './job-command.js';
import { jobStatusJsonSchema } from './job-status-contract.js';

const GH = 'ghp_SENTINEL';
const CLAUDE = 'sk-ant-SENTINEL';

const RESULT = (outcome: string, pr: unknown = null) =>
  JSON.stringify({
    schemaVersion: 3,
    issue: 12,
    repo: 'on-par/foreman',
    outcome,
    exitReason: `ended ${outcome}`,
    pr,
    branch: null,
    baseSha: null,
    headSha: null,
    startedAt: 's',
    finishedAt: 'f',
    phases: [],
    cost: { usd: 0, byModel: {} },
    reworkRounds: 0,
  });

interface Harness {
  deps: JobDeps;
  calls: Array<{ cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
  events: string[];
  writes: Array<{ path: string; text: string; mode?: number }>;
  stdout: string[];
  logs: string[];
}

function harness(
  child: Partial<JobRunResult> = { code: 0, signal: null, stdout: `progress\n${RESULT('merged')}\n` },
  opts: { existing?: Set<string>; nonEmpty?: boolean; gitConfigured?: boolean; env?: NodeJS.ProcessEnv } = {},
): Harness {
  const h: Harness = { calls: [], events: [], writes: [], stdout: [], logs: [], deps: undefined as never };
  const existing = opts.existing ?? new Set<string>();
  let clock = 0;
  h.deps = {
    env: opts.env ?? { GH_TOKEN: GH, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE, HOME: '/home/node' },
    run: async (cmd, args, o) => {
      h.calls.push({ cmd, args, cwd: o.cwd, env: o.env });
      h.events.push([cmd, ...args].slice(0, 3).join(' '));
      if (cmd === 'node') return { code: 0, signal: null, stdout: '', ...child };
      if (cmd === 'git' && args[0] === 'config' && args.length === 2) {
        return {
          code: opts.gitConfigured === true ? 0 : 1,
          signal: null,
          stdout: opts.gitConfigured === true ? 'set\n' : '',
        };
      }
      return { code: 0, signal: null, stdout: '' };
    },
    exists: (p) => existing.has(p),
    isEmptyDir: () => opts.nonEmpty !== true,
    mkdir: (p) => void h.events.push(`mkdir ${p}`),
    writeFile: (path, text, mode) => void h.writes.push({ path, text, mode }),
    appendFile: (path, text) => void h.writes.push({ path, text }),
    readFile: () => '',
    now: () => (clock += 1000),
    stdout: (line) => void h.stdout.push(line),
    log: (line) => void h.logs.push(line),
    cliEntry: { node: 'node', script: '/opt/factory/cli.js' },
  };
  return h;
}

const OPTS = { repo: 'on-par/foreman', issue: '12', merge: true };

describe('runJob', () => {
  it('clones the repo, runs run-issue --in-place --merge --json in the clone and exits with the child code', async () => {
    const h = harness();
    expect(await runJob(OPTS, h.deps)).toBe(0);
    const order = h.calls.map((c) => `${c.cmd} ${c.args.slice(0, 2).join(' ')}`);
    expect(order[0]).toBe('gh auth setup-git');
    expect(order[1]).toBe('git clone https://github.com/on-par/foreman.git');
    expect(order.slice(2, 4)).toEqual(['git config user.name', 'git config user.name']);
    const child = h.calls.at(-1)!;
    expect(child.cmd).toBe('node');
    expect(child.args).toEqual(['/opt/factory/cli.js', 'run-issue', '12', '--in-place', '--json', '--merge']);
    expect(child.cwd).toBe('/home/node/work/foreman');
    expect(child.env?.FACTORY_CONFIG_PATH).toBe('/home/node/work/.factory-job/container-defaults.yaml');
    const cloneIndex = h.calls.findIndex((c) => c.args[0] === 'clone');
    expect(h.calls[cloneIndex]!.args[2]).toBe('/home/node/work/foreman');
    const excludeWrites = h.writes.filter((w) => w.path.endsWith('.git/info/exclude')).map((w) => w.text);
    expect(excludeWrites).toEqual(['/.factory/state/\n', '/.factory/\n']);
    expect(h.events).toContain('mkdir /home/node/work/foreman/.factory');
  });

  it('sets git identity only when unset', async () => {
    const unset = harness();
    await runJob(OPTS, unset.deps);
    expect(unset.calls.filter((c) => c.args[0] === 'config' && c.args.length === 3).map((c) => c.args[1])).toEqual([
      'user.name',
      'user.email',
    ]);
    const set = harness(undefined, { gitConfigured: true });
    await runJob(OPTS, set.deps);
    expect(set.calls.filter((c) => c.args[0] === 'config' && c.args.length === 3)).toHaveLength(0);
  });

  it('prints one final JSON status line with merged true, the PR url and timings', async () => {
    const h = harness({
      code: 0,
      signal: null,
      stdout: `${RESULT('merged', { number: 9, url: 'https://github.com/on-par/foreman/pull/9', state: 'merged' })}\n\n`,
    });
    await runJob(OPTS, h.deps);
    expect(h.stdout).toHaveLength(1);
    const line = jobStatusJsonSchema.parse(JSON.parse(h.stdout[0]!));
    expect(line).toMatchObject({
      merged: true,
      outcome: 'merged',
      exitCode: 0,
      pr: { number: 9, url: 'https://github.com/on-par/foreman/pull/9' },
      configSource: 'container defaults',
    });
    expect(line.timings.cloneMs).not.toBeNull();
    expect(line.timings.runMs).not.toBeNull();
    expect(h.logs).toContain(
      'factory job: config source: container defaults; constitution source: repo instruction files / bundled',
    );
  });

  it('writes container defaults with mode 0600 and the onboarding file only when absent', async () => {
    const h = harness();
    await runJob(OPTS, h.deps);
    expect(h.writes.find((w) => w.path === '/home/node/.claude.json')).toEqual({
      path: '/home/node/.claude.json',
      text: '{"hasCompletedOnboarding":true}\n',
      mode: 0o600,
    });
    const defaults = h.writes.find((w) => w.path.endsWith('container-defaults.yaml'));
    expect(defaults?.mode).toBe(0o600);
    expect(defaults?.text).toContain('runtime: none');
    expect(defaults?.text).toContain('minFreeGb: 2');

    const present = harness(undefined, { existing: new Set(['/home/node/.claude.json']) });
    await runJob(OPTS, present.deps);
    expect(present.writes.find((w) => w.path === '/home/node/.claude.json')).toBeUndefined();
  });

  it('skips the /.factory/ exclude when the clone already has a .factory dir and writes no defaults', async () => {
    const h = harness(undefined, {
      existing: new Set(['/home/node/work/foreman/.factory', '/home/node/work/foreman/.factory/config.yaml']),
    });
    expect(await runJob(OPTS, h.deps)).toBe(0);
    expect(h.writes.filter((w) => w.path.endsWith('exclude')).map((w) => w.text)).toEqual(['/.factory/state/\n']);
    expect(h.writes.some((w) => w.path.endsWith('container-defaults.yaml'))).toBe(false);
  });

  it('exits 2 without deleting when the clone dir exists and is not empty', async () => {
    const h = harness(undefined, { existing: new Set(['/home/node/work/foreman']), nonEmpty: true });
    expect(await runJob(OPTS, h.deps)).toBe(2);
    expect(h.calls.some((c) => c.args[0] === 'clone' || c.cmd === 'rm')).toBe(false);
    expect(jobStatusJsonSchema.parse(JSON.parse(h.stdout[0]!)).outcome).toBe('failed');
  });

  it.each([1, 11, 16])('propagates child exit code %i', async (code) => {
    const h = harness({ code, signal: null, stdout: `${RESULT('parked')}\n` });
    expect(await runJob({ ...OPTS, merge: false }, h.deps)).toBe(code);
    expect(JSON.parse(h.stdout[0]!)).toMatchObject({ exitCode: code, outcome: 'parked', merged: false });
  });

  it('maps a signal to exit 1', async () => {
    const h = harness({ code: null, signal: 'SIGKILL', stdout: '' });
    expect(await runJob(OPTS, h.deps)).toBe(1);
    expect(JSON.parse(h.stdout[0]!).exitReason).toBe('killed by SIGKILL');
  });

  it('treats exit 0 without a valid result as exit 2', async () => {
    for (const stdout of ['not json\n', '', '{"schemaVersion":3}\n']) {
      const h = harness({ code: 0, signal: null, stdout });
      expect(await runJob(OPTS, h.deps)).toBe(2);
      expect(jobStatusJsonSchema.parse(JSON.parse(h.stdout[0]!))).toMatchObject({ outcome: 'failed', exitCode: 2 });
    }
  });

  it('exits 2 with a status line when GH_TOKEN or an agent token is missing', async () => {
    for (const env of [{ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE }, { GH_TOKEN: GH }]) {
      const h = harness(undefined, { env: { ...env, HOME: '/h' } });
      expect(await runJob(OPTS, h.deps)).toBe(2);
      expect(h.calls).toHaveLength(0);
      expect(jobStatusJsonSchema.parse(JSON.parse(h.stdout[0]!)).exitCode).toBe(2);
    }
  });

  it('reports invalid flags as exit 2 even for an unparsable issue', async () => {
    const h = harness();
    expect(await runJob({ repo: '..', issue: 'x' }, h.deps)).toBe(2);
    expect(JSON.parse(h.stdout[0]!).issue).toBe(0);
  });

  it('fails with exit 2 when git clone or gh auth fails', async () => {
    const h = harness();
    const run = h.deps.run;
    h.deps.run = async (cmd, args, o) =>
      cmd === 'gh' || args[0] === 'clone' ? { code: 128, signal: null, stdout: '' } : run(cmd, args, o);
    expect(await runJob(OPTS, h.deps)).toBe(2);
    expect(h.stdout[0]).toContain('gh auth setup-git failed');
  });

  it('never writes token values to stdout, stderr or the status line', async () => {
    const h = harness(undefined, { existing: new Set() });
    await runJob(OPTS, h.deps);
    const bad = harness(undefined, { env: { GH_TOKEN: GH, HOME: '/h' } });
    await runJob(OPTS, bad.deps);
    for (const text of [...h.stdout, ...h.logs, ...bad.stdout, ...bad.logs]) {
      expect(text).not.toContain(GH);
      expect(text).not.toContain(CLAUDE);
    }
    expect(h.calls.every((c) => !c.args.join(' ').includes(GH))).toBe(true);
  });

  it('spawns every process from an argument list, never through a shell', async () => {
    const h = harness();
    await runJob({ ...OPTS, repo: 'o/n;rm -rf', issue: '12' }, h.deps);
    expect(h.calls).toHaveLength(0);
    const ok = harness();
    await runJob(OPTS, ok.deps);
    expect(ok.calls.map((c) => c.cmd).every((c) => ['gh', 'git', 'node'].includes(c))).toBe(true);
  });
});

describe('runJob as root', () => {
  it('warns that Claude Code refuses skip-permissions as root, without failing', async () => {
    const uid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    const h = harness();
    expect(await runJob(OPTS, h.deps)).toBe(0);
    uid.mockRestore();
    expect(h.logs.some((l) => l.includes('as root'))).toBe(true);
  });
});

describe('cmdJob', () => {
  const tempDirs = createTempDirs();
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await tempDirs.cleanup();
  });

  it('throws a silent CliExitError carrying the exit code on invalid flags', async () => {
    vi.stubEnv('GH_TOKEN', 'x');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(cmdJob({ repo: 'bad', issue: '1' })).rejects.toMatchObject({ code: 2, name: 'CliExitError' });
  });

  it('runs gh, git and the factory entry for real and resolves when the run exits 0', async () => {
    const root = tempDirs.makeSync('factory-job-cmd-');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    script('gh', 'exit 0');
    script('git', 'if [ "$1" = clone ]; then mkdir -p "$3/.git/info"; fi; exit 0');
    const entry = join(root, 'entry.js');
    writeFileSync(entry, `console.log(${JSON.stringify(RESULT('merged'))});\n`);
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    vi.stubEnv('HOME', root);
    vi.stubEnv('GH_TOKEN', 'x');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'y');
    const argv = [...process.argv];
    process.argv[1] = entry;
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(cmdJob({ repo: 'on-par/foreman', issue: '12' })).resolves.toBeUndefined();
    } finally {
      process.argv = argv;
    }
    const line = out.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('{')) ?? '';
    expect(JSON.parse(line)).toMatchObject({ merged: true, exitCode: 0 });
    expect(err).toHaveBeenCalled();
  });
});
