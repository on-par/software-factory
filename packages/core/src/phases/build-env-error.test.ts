import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { buildPhase } from './build.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

async function build(output: string) {
  const worktree = await tempDirs.make('build-env-error-');
  const prompts: string[] = [];
  let diffs = 0;
  const router = {
    run: async (_task: string, prompt: string) => {
      prompts.push(prompt);
      return { model: 'fake-model', output, exitCode: 0, attempts: [] };
    },
  } as any;
  const result = await buildPhase({
    issue: 3332,
    repo: 'on-par/software-factory',
    worktree,
    specPath: join(worktree, 'issue-3332.md'),
    branch: 'factory/3332-env',
    route: 'claude',
    router,
    constitution: null,
    log: () => {},
    collectDiff: async () => {
      diffs++;
      return { text: '', baseRef: 'origin/main', truncated: false };
    },
  });
  return { result, prompts, diffs: () => diffs };
}

describe('buildPhase ENV-ERROR (#3332)', () => {
  it('stops with sandbox_env on an ENV-ERROR: line, ahead of ESCALATE, and collects no diff', async () => {
    const line = 'ENV-ERROR: verify: ENVIRONMENT ERROR: loopback bind denied (EPERM)';
    const { result, diffs } = await build(`tried\n${line}\nESCALATE: help`);
    expect(result).toMatchObject({ ok: false, reason: 'sandbox_env', envError: line });
    expect(diffs()).toBe(0);
  });

  it('ignores ENV-ERROR: mid-line', async () => {
    const { result } = await build('saw ENV-ERROR: in a log');
    expect(result.reason).not.toBe('sandbox_env');
  });

  it('tells the agent the ENV-ERROR rule in the prompt', async () => {
    const { prompts } = await build('done');
    expect(prompts[0]).toContain('ENV-ERROR:');
    expect(prompts[0]).toContain('loopback bind denied (EPERM)');
  });
});
