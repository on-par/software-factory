import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempWorktrees } from '../test-support/temp-worktree.js';
import { resolveLintCommands } from './index.js';

const { makeWorktree, cleanup } = createTempWorktrees('lint-commands-test-');

afterEach(async () => {
  await cleanup();
});

function makeContext(worktree: string) {
  return { worktree, specPath: join(worktree, 'no-such-spec.md'), constitutionBody: 'test constitution' };
}

describe('resolveLintCommands', () => {
  const lintPkg = '{"name":"fixture","version":"1.0.0","scripts":{"lint":"eslint ."}}';

  it('returns npm run lint when package.json has a lint script', async () => {
    const worktree = await makeWorktree({ 'package.json': lintPkg });

    expect(await resolveLintCommands(makeContext(worktree))).toEqual([{ label: 'lint', argv: ['npm', 'run', 'lint'] }]);
  });

  it('returns npx tsc --noEmit when tsconfig.json exists', async () => {
    const worktree = await makeWorktree({ 'tsconfig.json': '{}' });

    expect(await resolveLintCommands(makeContext(worktree))).toEqual([
      { label: 'tsc', argv: ['npx', 'tsc', '--noEmit'] },
    ]);
  });

  it('returns lint then tsc when both are present', async () => {
    const worktree = await makeWorktree({ 'package.json': lintPkg, 'tsconfig.json': '{}' });

    expect(await resolveLintCommands(makeContext(worktree))).toEqual([
      { label: 'lint', argv: ['npm', 'run', 'lint'] },
      { label: 'tsc', argv: ['npx', 'tsc', '--noEmit'] },
    ]);
  });

  it('returns no commands when there is no lint script and no tsconfig.json', async () => {
    const worktree = await makeWorktree({ 'package.json': '{"name":"fixture","version":"1.0.0"}' });

    expect(await resolveLintCommands(makeContext(worktree))).toEqual([]);
  });

  it('accepts a bare { worktree } source so BUILD and doctor can resolve without a full CheckerContext', async () => {
    const worktree = await makeWorktree({ 'package.json': lintPkg });

    expect(await resolveLintCommands({ worktree })).toEqual([{ label: 'lint', argv: ['npm', 'run', 'lint'] }]);
  });
});
