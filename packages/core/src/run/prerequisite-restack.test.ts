// packages/core/src/run/prerequisite-restack.test.ts — cross-issue stack restack (#3916), on a real git fixture.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prerequisiteStackOrder } from '../phases/stack-order.js';
import { parsePrerequisiteStackMarker, type PrerequisiteStackTarget } from '../queue/prerequisite-stack.js';
import { restackOnPrerequisite } from './prerequisite-restack.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, file: string, content: string, msg: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

const tempDirs = createTempDirs();

describe('restackOnPrerequisite', () => {
  let remote: string;
  let root: string;
  let update: ReturnType<typeof vi.fn<(args: Record<string, unknown>) => Promise<unknown>>>;
  let prs: Record<number, { base: string; body: string }>;

  const octokit = (): Octokit =>
    ({
      rest: {
        pulls: {
          get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({
            data: { base: { ref: prs[pull_number]!.base }, body: prs[pull_number]!.body },
          })),
          update,
        },
      },
    }) as never;

  const remoteLog = (b: string): string[] =>
    git(remote, 'log', '--format=%s', `main..${b}`).split('\n').filter(Boolean);
  const remoteHead = (b: string): string => git(remote, 'rev-parse', `refs/heads/${b}`);
  const target = (issue: number, branch: string, headSha: string): PrerequisiteStackTarget => ({
    issue,
    prNumber: issue * 10,
    branch,
    headSha,
  });
  const push = (b: string): void => void git(root, 'push', 'origin', b);
  const squashToMain = (b: string): void => {
    git(root, 'checkout', 'main');
    git(root, 'merge', '--squash', b);
    git(root, 'commit', '-m', `squash ${b}`);
    push('main');
  };

  beforeEach(() => {
    const dir = tempDirs.makeSync('prereq-restack-');
    remote = join(dir, 'remote.git');
    root = join(dir, 'root');
    update = vi.fn(async () => ({}));
    prs = {};
    git(dir, 'init', '--bare', '-b', 'main', remote);
    git(dir, 'clone', remote, root);
    for (const [k, v] of [
      ['user.name', 'T'],
      ['user.email', 't@example.com'],
      ['commit.gpgsign', 'false'],
    ] as const)
      git(root, 'config', k, v);
    git(root, 'checkout', '-b', 'main');
    commit(root, 'a.txt', 'base\n', 'base');
    push('main');
  });

  afterEach(() => tempDirs.cleanup());

  const stacked = (b: PrerequisiteStackTarget, x: number, base: string): string =>
    `## Summary\n\nImplements #${x}.\n\n${prerequisiteStackOrder(b, x, base)}\n\nrest\n`;

  it("rebases onto main without the prerequisite's commits and retargets the PR", async () => {
    git(root, 'checkout', '-b', 'factory/5-b');
    const bHead = commit(root, 'b.txt', 'b\n', 'b only');
    push('factory/5-b');
    git(root, 'checkout', '-b', 'factory/6-x');
    const xHead = commit(root, 'x.txt', 'x\n', 'x only');
    push('factory/6-x');
    squashToMain('factory/5-b');
    const b = target(5, 'factory/5-b', bHead);
    prs[60] = { base: 'factory/5-b', body: stacked(b, 6, 'factory/5-b') };

    const out = await restackOnPrerequisite({
      repoRoot: root,
      octokit: octokit(),
      repo: 'o/r',
      prNumber: 60,
      branch: 'factory/6-x',
      recordedHead: xHead,
      stackedOn: b,
      onto: { kind: 'main', mergedHead: bHead },
    });
    expect(out).toMatchObject({ status: 'restacked', retargeted: true, headSha: remoteHead('factory/6-x') });
    expect(remoteLog('factory/6-x')).toEqual(['x only']);
    const arg = update.mock.calls[0]![0] as { pull_number: number; base: string; body: string };
    expect(arg).toMatchObject({ pull_number: 60, base: 'main' });
    expect(arg.body).toContain('prerequisite merged; stacked on `main`');
    expect(parsePrerequisiteStackMarker(arg.body)).toBeUndefined();
  });

  it("rebases onto the prerequisite's new head and records it in the marker", async () => {
    git(root, 'checkout', '-b', 'factory/5-b');
    const bHead = commit(root, 'b.txt', 'b\n', 'b only');
    push('factory/5-b');
    git(root, 'checkout', '-b', 'factory/6-x');
    const xHead = commit(root, 'x.txt', 'x\n', 'x only');
    push('factory/6-x');
    git(root, 'checkout', 'factory/5-b');
    const newHead = commit(root, 'b2.txt', 'b2\n', 'b second');
    push('factory/5-b');
    const b = target(5, 'factory/5-b', bHead);
    prs[60] = { base: 'factory/5-b', body: stacked(b, 6, 'factory/5-b') };

    const out = await restackOnPrerequisite({
      repoRoot: root,
      octokit: octokit(),
      repo: 'o/r',
      prNumber: 60,
      branch: 'factory/6-x',
      recordedHead: xHead,
      stackedOn: b,
      onto: { kind: 'prerequisite', newHead },
    });
    expect(out).toMatchObject({ status: 'restacked', retargeted: false });
    expect(remoteLog('factory/6-x')).toEqual(['x only', 'b second', 'b only']);
    const arg = update.mock.calls[0]![0] as { body: string; base?: string };
    expect(arg).not.toHaveProperty('base');
    expect(parsePrerequisiteStackMarker(arg.body)?.headSha).toBe(newHead);
  });

  it('parks when its own branch moved since it was recorded', async () => {
    git(root, 'checkout', '-b', 'factory/5-b');
    const bHead = commit(root, 'b.txt', 'b\n', 'b only');
    push('factory/5-b');
    git(root, 'checkout', '-b', 'factory/6-x');
    const xHead = commit(root, 'x.txt', 'x\n', 'x only');
    push('factory/6-x');
    commit(root, 'human.txt', 'h\n', 'human fix');
    push('factory/6-x');
    const humanHead = remoteHead('factory/6-x');
    squashToMain('factory/5-b');

    const out = await restackOnPrerequisite({
      repoRoot: root,
      octokit: octokit(),
      repo: 'o/r',
      prNumber: 60,
      branch: 'factory/6-x',
      recordedHead: xHead,
      stackedOn: target(5, 'factory/5-b', bHead),
      onto: { kind: 'main', mergedHead: bHead },
    });
    expect(out.status === 'park' && out.reason).toContain('a human may have pushed');
    expect(remoteHead('factory/6-x')).toBe(humanHead);
    expect(update).not.toHaveBeenCalled();
  });

  it('parks naming the conflicting files when the rebase conflicts', async () => {
    git(root, 'checkout', '-b', 'factory/5-b');
    const bHead = commit(root, 'b.txt', 'b\n', 'b only');
    push('factory/5-b');
    git(root, 'checkout', '-b', 'factory/6-x');
    const xHead = commit(root, 'a.txt', 'x edit\n', 'x edits a');
    push('factory/6-x');
    git(root, 'checkout', 'main');
    commit(root, 'a.txt', 'main edit\n', 'main edits a');
    push('main');

    const out = await restackOnPrerequisite({
      repoRoot: root,
      octokit: octokit(),
      repo: 'o/r',
      prNumber: 60,
      branch: 'factory/6-x',
      recordedHead: xHead,
      stackedOn: target(5, 'factory/5-b', bHead),
      onto: { kind: 'main', mergedHead: bHead },
    });
    expect(out).toMatchObject({ status: 'park', files: ['a.txt'] });
    expect(remoteHead('factory/6-x')).toBe(xHead);
  });

  it('restacks a chain bottom-up after the root merges', async () => {
    git(root, 'checkout', '-b', 'factory/4-a');
    const aHead = commit(root, 'a1.txt', 'a\n', 'a only');
    push('factory/4-a');
    git(root, 'checkout', '-b', 'factory/5-b');
    const bHead = commit(root, 'b.txt', 'b\n', 'b only');
    push('factory/5-b');
    git(root, 'checkout', '-b', 'factory/6-c');
    const cHead = commit(root, 'c.txt', 'c\n', 'c only');
    push('factory/6-c');
    squashToMain('factory/4-a');
    const a = target(4, 'factory/4-a', aHead);
    const b = target(5, 'factory/5-b', bHead);
    prs[50] = { base: 'factory/4-a', body: stacked(a, 5, 'factory/4-a') };
    prs[60] = { base: 'factory/5-b', body: stacked(b, 6, 'factory/5-b') };

    const first = await restackOnPrerequisite({
      repoRoot: root,
      octokit: octokit(),
      repo: 'o/r',
      prNumber: 50,
      branch: 'factory/5-b',
      recordedHead: bHead,
      stackedOn: a,
      onto: { kind: 'main', mergedHead: aHead },
    });
    expect(first.status).toBe('restacked');
    const newB = remoteHead('factory/5-b');
    expect(remoteLog('factory/5-b')).toEqual(['b only']);

    const second = await restackOnPrerequisite({
      repoRoot: root,
      octokit: octokit(),
      repo: 'o/r',
      prNumber: 60,
      branch: 'factory/6-c',
      recordedHead: cHead,
      stackedOn: b,
      onto: { kind: 'prerequisite', newHead: newB },
    });
    expect(second.status).toBe('restacked');
    expect(remoteLog('factory/6-c')).toEqual(['c only', 'b only']);
    expect(git(remote, 'rev-parse', 'factory/6-c^')).toBe(newB);
  });
});
