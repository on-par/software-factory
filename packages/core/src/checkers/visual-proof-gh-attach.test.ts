import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { fakeOctokit, type FakeOctokitOptions } from '../test-support/fake-octokit.js';
import { cmdResult } from '../test-support/visual-proof-test-helpers.js';
import type { CommandResult } from '../utils/command-runner.js';
import { VISUAL_PROOF_END, VISUAL_PROOF_START } from './visual-proof-attach.js';
import { publishVisualProofWithGh } from './visual-proof-gh-attach.js';
import type { VisualProofCapture, VisualProofResult } from './visual-proof.js';

const dirs = createTempDirs();
afterAll(() => dirs.cleanup());

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const target = { owner: 'o', repo: 'r', prNumber: 7 };
const NEW_GH = { stdout: 'gh version 2.103.0 (2026-11-01)\n' };
const before = { file: 'before.png', finalPath: '/items', bytes: 4 };
const view = { route: '/items', state: 'created', viewport: { width: 1280, height: 800 }, finalPath: '/items' };
const capture: VisualProofCapture = { ...view, file: 'after.png', bytes: 4, before };

function setup(gh: Partial<Record<'version' | 'edit', Partial<CommandResult>>> = {}, opts?: FakeOctokitOptions) {
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
  const publish = (r = result) => publishVisualProofWithGh(octokit, target, r, 'required', run);
  return { outDir, calls, argv, seen, result, publish };
}

describe('publishVisualProofWithGh', () => {
  it('attaches before and after screenshots through gh pr edit --attach', async () => {
    const { outDir, calls, argv, seen, publish } = setup();
    const r = await publish();
    expect(argv).toEqual([
      ['gh', '--version'],
      ['gh', 'pr', 'edit', '7', '--repo', 'o/r', '--body-file', join(outDir, 'visual-proof-pr-body.md')]
        .concat(['--attach', './after.png#/items created after at abcdef012345'])
        .concat(['--attach', './before.png#/items created before']),
    ]);
    expect(seen.cwd).toBe(outDir);
    for (const text of ['Original body', VISUAL_PROOF_START, '](./before.png)', '](./after.png)']) {
      expect(seen.body).toContain(text);
    }
    expect(calls.pullsUpdate).toEqual([]);
    expect(calls.createCommitStatus).toEqual([expect.objectContaining({ sha: HEAD, state: 'success' })]);
    expect(r).toMatchObject({ status: 'pass', images: [{ url: './after.png', beforeUrl: './before.png' }] });
  });

  it('attaches a gif clip with alt text and a video clip without', async () => {
    const { argv, result, publish } = setup();
    const clip = (format: 'gif' | 'webm') => ({ file: `c.${format}`, format, bytes: 4 });
    const captures = [
      { ...capture, clip: clip('gif') },
      { ...view, file: 'b.png', bytes: 4, clip: clip('webm') },
    ];
    await publish({ ...result, captures });
    expect(argv[1]?.slice(-4)).toEqual(['--attach', './b.png#/items created at abcdef012345', '--attach', './c.webm']);
    expect(argv[1]).toContain('./c.gif#clip');
  });

  it('fails the proof naming the 2.103.0 minimum when gh is not found', async () => {
    for (const version of [{ ok: false, exitCode: -1 }, { stdout: 'gh version 2.92.0 (2026-04-28)\n' }]) {
      const { argv, calls, publish } = setup({ version });
      const r = await publish();
      expect(r.status).toBe('fail');
      expect(r.diagnostic).toMatch(version.ok === false ? /not found.+2\.103\.0/ : /2\.92\.0 found.+2\.103\.0/);
      expect(argv).toEqual([['gh', '--version']]);
      expect(calls.createCommitStatus[0]?.state).toBe('failure');
      expect(calls.pullsUpdate[0]?.body).toContain('Visual proof unavailable:');
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
    const { calls, publish } = setup({ edit: { ok: false, exitCode: 1, stderr, stdout: 'https://x/o/r/pull/70' } });
    expect((await publish()).diagnostic).toMatch(/^gh pr edit --attach failed \(exit 1\): HTTP 403: Resource/);
    expect(calls.createCommitStatus[0]?.state).toBe('failure');
  });

  it('replaces a partially attached block with the unavailable reason', async () => {
    const half = `Intro\n${VISUAL_PROOF_START}\n![a](https://x/assets/1)\n![b](./before.png)\n${VISUAL_PROOF_END}`;
    const edit = { ok: false, stdout: 'https://github.com/o/r/pull/7', stderr: 'could not upload ./before.png' };
    const { calls, publish } = setup({ edit }, { prBodies: ['Original body', half] });
    const r = await publish();
    const body = calls.pullsUpdate[0]?.body ?? '';
    expect(r.diagnostic).toMatch(/^partial attach: .+: could not upload \.\/before\.png$/);
    expect(body).toMatch(/Visual proof unavailable: partial attach: .+: could not upload \.\/before\.png/);
    expect(body).not.toContain('![');
    expect(calls.createCommitStatus[0]).toMatchObject({ state: 'failure', description: r.diagnostic?.slice(0, 140) });
  });

  it('publishes a non-pass result or a missing capture directory without running gh pr edit', async () => {
    const { argv, calls, result, publish } = setup();
    const unavailable = { ...result, status: 'unavailable' as const, diagnostic: 'no port' };
    expect(await publish(unavailable)).toBe(unavailable);
    const r = await publish({ ...result, outDir: undefined });
    expect(r.diagnostic).toBe('attach failed: capture output directory unknown');
    expect(argv).toEqual([]);
    expect(calls.createCommitStatus.map((s) => s.description)).toEqual(['no port', r.diagnostic]);
  });
});
