import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { fakeOctokit, type FakeOctokitOptions } from '../test-support/fake-octokit.js';
import { cmdResult } from '../test-support/visual-proof-test-helpers.js';
import type { CommandResult } from '../utils/command-runner.js';
import { VISUAL_PROOF_START } from './visual-proof-attach.js';
import { publishVisualProofWithGh } from './visual-proof-gh-attach.js';
import type { VisualProofCapture, VisualProofResult } from './visual-proof.js';

const dirs = createTempDirs();
afterAll(() => dirs.cleanup());

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const target = { owner: 'o', repo: 'r', prNumber: 7 };
const NEW_GH = { stdout: 'gh version 2.103.0 (2026-11-01)\n' };
const capture: VisualProofCapture = {
  route: '/items',
  state: 'created',
  viewport: { width: 1280, height: 800 },
  finalPath: '/items',
  file: 'after.png',
  bytes: 4,
  before: { file: 'before.png', finalPath: '/items', bytes: 4 },
};

function setup(
  gh: { version?: Partial<CommandResult>; edit?: Partial<CommandResult> } = {},
  opts?: FakeOctokitOptions,
) {
  const outDir = dirs.makeSync('visual-proof-gh-');
  const { octokit, calls } = fakeOctokit(opts);
  const argv: string[][] = [];
  const seen: { body?: string; cwd?: string } = {};
  const run = async (args: readonly string[], options?: { cwd?: string }) => {
    argv.push([...args]);
    if (args[1] === '--version') return cmdResult(gh.version ?? NEW_GH);
    Object.assign(seen, { body: readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'), cwd: options?.cwd });
    return cmdResult(gh.edit ?? { stdout: 'https://github.com/o/r/pull/7\n' });
  };
  const result: VisualProofResult = { status: 'pass', headSha: HEAD, runId: 'run-9', outDir, captures: [capture] };
  const publish = (r: VisualProofResult = result, mode?: 'required' | 'advisory') =>
    publishVisualProofWithGh(octokit, target, r, mode, run);
  return { outDir, calls, argv, seen, result, publish };
}

describe('publishVisualProofWithGh', () => {
  it('attaches before and after screenshots through gh pr edit --attach', async () => {
    const { outDir, calls, argv, seen, publish } = setup();
    const r = await publish();
    const bodyFile = join(outDir, 'visual-proof-pr-body.md');
    expect(argv).toEqual([
      ['gh', '--version'],
      ['gh', 'pr', 'edit', '7', '--repo', 'o/r', '--body-file', bodyFile]
        .concat(['--attach', './after.png#/items created after at abcdef012345'])
        .concat(['--attach', './before.png#/items created before']),
    ]);
    expect(seen.cwd).toBe(outDir);
    expect(seen.body).toContain('Original body');
    expect(seen.body).toContain(VISUAL_PROOF_START);
    expect(seen.body).toContain('](./before.png)');
    expect(seen.body).toContain('](./after.png)');
    expect(calls.pullsUpdate).toEqual([]);
    expect(calls.createCommitStatus).toEqual([expect.objectContaining({ sha: HEAD, state: 'success' })]);
    expect(r).toMatchObject({ status: 'pass', images: [{ url: './after.png', beforeUrl: './before.png' }] });
  });

  it('attaches a gif clip with alt text and a video clip without', async () => {
    for (const [format, arg] of [
      ['gif', './clip.gif#clip'],
      ['webm', './clip.webm'],
    ] as const) {
      const { argv, result, publish } = setup();
      const clip = { file: `clip.${format}`, format, bytes: 4 };
      await publish({ ...result, captures: [{ ...capture, before: undefined, clip }] });
      expect(argv[1]?.slice(-4)).toEqual(['--attach', './after.png#/items created at abcdef012345', '--attach', arg]);
    }
  });

  it('fails the proof naming the 2.103.0 minimum when gh is not found', async () => {
    for (const version of [{ ok: false, exitCode: -1 }, { stdout: 'gh version 2.92.0 (2026-04-28)\n' }]) {
      const { argv, calls, publish } = setup({ version });
      const r = await publish();
      expect(r.status).toBe('fail');
      expect(r.diagnostic).toContain('2.103.0');
      expect(argv).toEqual([['gh', '--version']]);
      expect(calls.createCommitStatus[0]?.state).toBe('failure');
      expect(calls.pullsUpdate[0]?.body).toContain('Visual proof unavailable:');
      expect(r.diagnostic).toContain(version.ok === false ? 'not found' : '2.92.0 found');
    }
  });

  const webm = { format: 'webm' as const, bytes: 4 };
  const unsafe = [
    { file: 'a (1).png' },
    { before: { file: 'a b/x.png', finalPath: '/items', bytes: 4 } },
    { clip: { ...webm, file: 'x](y).webm' } },
  ];
  it.each(unsafe)('fails an unsafe proof file name without running gh: %j', async (bad) => {
    const { argv, calls, result, publish } = setup();
    const r = await publish({ ...result, captures: [{ ...capture, ...bad }] });
    expect(r.diagnostic).toMatch(/^unsafe proof file name for \/items \(state created\): use only letters/);
    expect(argv).toEqual([]);
    expect(calls.createCommitStatus).toEqual([expect.objectContaining({ state: 'failure' })]);
  });

  it('publishes the unavailable block when the PR body cannot be written', async () => {
    const { calls, result, publish } = setup();
    const r = await publish({ ...result, outDir: join(result.outDir ?? '', 'gone') });
    expect(r.diagnostic).toMatch(/^attach failed: could not write the PR body: ENOENT/);
    expect(calls.pullsUpdate[0]?.body).toContain('Visual proof unavailable: attach failed');
  });

  it('fails the proof with gh stderr when gh pr edit exits non-zero', async () => {
    const stderr = 'HTTP 403: Resource not accessible\nthe pull request was not changed\n';
    const { calls, publish } = setup({ edit: { ok: false, exitCode: 1, stderr } });
    const r = await publish();
    expect(r).toMatchObject({
      status: 'fail',
      diagnostic: expect.stringContaining('HTTP 403: Resource not accessible'),
    });
    expect(r.diagnostic).toContain('exit 1');
    expect(calls.createCommitStatus[0]?.state).toBe('failure');
  });

  it('publishes a non-pass result or a missing capture directory without running gh pr edit', async () => {
    const { argv, calls, result, publish } = setup();
    const unavailable = { ...result, status: 'unavailable' as const, diagnostic: 'no port' };
    expect(await publish(unavailable, 'advisory')).toBe(unavailable);
    const r = await publish({ ...result, outDir: undefined });
    expect(r.diagnostic).toBe('attach failed: capture output directory unknown');
    expect(argv).toEqual([]);
    expect(calls.createCommitStatus.map((s) => s.state)).toEqual(['success', 'failure']);
  });
});
