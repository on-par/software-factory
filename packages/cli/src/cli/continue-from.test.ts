import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createTempDirs, fakeOctokit } from '@on-par/factory-core/testing';

import { continuedBranchFor, continueFromConflict, resolveContinueFrom } from './continue-from.js';
import { CliExitError } from './errors.js';

const tempDirs = createTempDirs();
afterAll(() => tempDirs.cleanup());

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function repo(): { root: string; head: string } {
  const root = tempDirs.makeSync('continue-from-');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'wip']);
  git(root, ['branch', 'wip/issue-7-x']);
  return { root, head: git(root, ['rev-parse', 'HEAD']) };
}

const handoff = (headSha: string | null) => ({
  version: 1,
  stopReason: 'deadline',
  phase: 'build',
  baseSha: null,
  wipBranch: 'wip/issue-7-x',
  headSha,
  specPath: null,
  criteria: [],
  lastFailure: null,
  nextStep: 'Finish BUILD',
  fitsOneRun: false,
});

function file(dir: string, body: unknown): string {
  const path = join(dir, 'handoff.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

const noComments = fakeOctokit({
  'users.getAuthenticated': async () => ({ data: { id: 1 } }),
  'issues.listComments': async () => ({ data: [] }),
}).octokit as Octokit;

async function failure(p: Promise<unknown>): Promise<CliExitError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliExitError);
  expect((err as CliExitError).code).toBe(2);
  return err as CliExitError;
}

const opts = (root: string, extra: Partial<Parameters<typeof resolveContinueFrom>[0]> = {}) => ({
  branch: 'wip/issue-7-x',
  octokit: noComments,
  repo: 'o/r',
  issue: 7,
  repoRoot: root,
  ...extra,
});

describe('resolveContinueFrom', () => {
  it('resolves the local WIP head when it matches a --handoff file, also inside a run-result JSON', async () => {
    const { root, head } = repo();
    const bare = await resolveContinueFrom(opts(root, { handoffFile: file(root, handoff(head)) }));
    expect(bare).toMatchObject({ branch: 'wip/issue-7-x', headSha: head, handoff: { headSha: head } });
    const wrapped = await resolveContinueFrom(
      opts(root, { handoffFile: file(root, { schemaVersion: 4, handoff: handoff(head) }) }),
    );
    expect(wrapped.headSha).toBe(head);
  });

  it('exits 2 naming both shas when the branch head does not match the handoff', async () => {
    const { root, head } = repo();
    const stale = 'f'.repeat(40);
    const err = await failure(resolveContinueFrom(opts(root, { handoffFile: file(root, handoff(stale)) })));
    expect(err.message).toContain(head);
    expect(err.message).toContain(stale);
    expect(err.message).toContain('nothing was changed');
  });

  it('exits 2 when the branch is missing', async () => {
    const { root, head } = repo();
    const err = await failure(
      resolveContinueFrom(opts(root, { branch: 'wip/nope', handoffFile: file(root, handoff(head)) })),
    );
    expect(err.message).toContain('wip/nope was not found');
  });

  it('exits 2 on an unreadable, invalid or absent handoff', async () => {
    const { root } = repo();
    expect(
      (await failure(resolveContinueFrom(opts(root, { handoffFile: join(root, 'nope.json') })))).message,
    ).toContain('could not read --handoff');
    expect(
      (await failure(resolveContinueFrom(opts(root, { handoffFile: file(root, { version: 2 }) })))).message,
    ).toContain('invalid handoff');
    expect((await failure(resolveContinueFrom(opts(root)))).message).toContain('no handoff comment found on #7');
    const broken = fakeOctokit({
      'users.getAuthenticated': async () => {
        throw new Error('401');
      },
    }).octokit as Octokit;
    expect((await failure(resolveContinueFrom(opts(root, { octokit: broken })))).message).toContain(
      'could not read the handoff comment on #7',
    );
  });

  it('reads the handoff from the issue comment when --handoff is omitted', async () => {
    const { root, head } = repo();
    const json = JSON.stringify(handoff(head), null, 2);
    const body = `<details><summary>handoff JSON</summary>\n\n\`\`\`\`\`\n${json}\n\`\`\`\`\`\n\n</details>\n\n<!-- factory-handoff v1 issue:7 -->`;
    const octokit = fakeOctokit({
      'users.getAuthenticated': async () => ({ data: { id: 1 } }),
      'issues.listComments': async () => ({ data: [{ id: 3, body, user: { id: 1 } }] }),
    }).octokit as Octokit;
    expect((await resolveContinueFrom(opts(root, { octokit }))).headSha).toBe(head);
  });
});

describe('continueFromConflict', () => {
  const none = { stack: false, inPlace: false };
  it('allows a plain or absent --continue-from and rejects bad combinations', () => {
    expect(continueFromConflict(none)).toBeUndefined();
    expect(continueFromConflict({ ...none, continueFrom: 'wip/x' })).toBeUndefined();
    expect(continueFromConflict({ ...none, handoff: 'h.json' })).toContain('--handoff needs --continue-from');
    expect(continueFromConflict({ ...none, continueFrom: '-x' })).toContain('invalid --continue-from');
    expect(continueFromConflict({ ...none, continueFrom: 'wip/x', stack: true })).toContain('drop --stack');
    expect(continueFromConflict({ ...none, continueFrom: 'wip/x', inPlace: true })).toContain('drop --in-place');
  });

  it('names the continued branch after the WIP head', () => {
    expect(continuedBranchFor('factory/7-x', 'abcdef1234')).toBe('factory/7-x-cont-abcdef1');
  });
});
