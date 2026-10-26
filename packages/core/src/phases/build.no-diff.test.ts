import { workKeyFromIssue } from '../work/work-key.js';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPhase } from './build.js';
import { workerOutputTail } from './build-no-diff.js';

const tempDirs = createTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

const fakeRouter = (output: string) =>
  ({
    run: async () => ({ model: 'fake-model', output, exitCode: 0, attempts: [] }),
  }) as any;

async function emptyBuild(output: string, openQuestions?: string[], excludedPaths?: string[]) {
  const worktree = await tempDirs.make('build-no-diff-test-');
  const logs: Array<{ type: string; msg: string }> = [];
  const result = await buildPhase({
    issue: workKeyFromIssue(3273),
    repo: 'on-par/software-factory',
    worktree,
    specPath: join(worktree, 'issue-3273.md'),
    branch: 'factory/3273-no-diff',
    route: 'claude',
    router: fakeRouter(output),
    constitution: null,
    log: (type, msg) => logs.push({ type, msg }),
    openQuestions,
    collectDiff: async () => ({ text: '', baseRef: 'origin/main', truncated: false, excludedPaths }),
  });
  return { result, fail: logs.find((l) => l.type === 'fail') };
}

describe('buildPhase no-diff cause and worker tail (#3273)', () => {
  it("a no-diff build records cause sandbox and the worker's last lines (#3225 on 10/19)", async () => {
    const { result, fail } = await emptyBuild('starting\nsandbox_apply: Operation not permitted\n');
    expect(result.reason).toBe('no_diff');
    expect(result.noDiffCause).toBe('sandbox');
    expect(fail?.msg).toContain('cause: sandbox');
    expect(fail?.msg).toContain('sandbox_apply');
    expect(result.noDiffDetail).toContain('sandbox_apply');
  });

  it('a no-diff build with a plan open question records cause open-questions and lists it (#3263)', async () => {
    const { result, fail } = await emptyBuild('nothing to do', ['Where do test commands come from?']);
    expect(result.noDiffCause).toBe('open-questions');
    expect(fail?.msg).toContain('Where do test commands come from?');
    expect(result.noDiffDetail).toContain('Where do test commands come from?');
  });

  it('a no-diff build redacts a ghp_ token in the worker tail and caps it at 2,000 characters', async () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
    const lines = Array.from({ length: 19 }, (_, i) => `line ${i} ${'x'.repeat(200)}`);
    const output = [`token ${token}`, ...lines].join('\n');
    const { result, fail } = await emptyBuild(output);
    expect(fail?.msg).not.toContain(token);
    expect(result.noDiffDetail).not.toContain(token);
    expect(workerOutputTail(output).length).toBeLessThanOrEqual(2000);
  });

  it('a no-diff build with no sandbox error and no open questions records cause unknown with the tail', async () => {
    const { result, fail } = await emptyBuild('first\nlast worker line');
    expect(result.noDiffCause).toBe('unknown');
    expect(fail?.msg).toContain('last worker line');
  });

  it('a junk-only build gets the tail but no cause', async () => {
    const { result, fail } = await emptyBuild('wrote pycache', undefined, ['pkg/__pycache__/m.pyc']);
    expect(result.reason).toBe('junk_only_diff');
    expect(result.noDiffCause).toBeUndefined();
    expect(result.noDiffDetail).toContain('wrote pycache');
    expect(fail?.msg).toContain('wrote pycache');
  });
});
