// packages/core/src/checkers/base-health.base-ref.test.ts — baseRef picks the ref whose SHA is tested (#3764)
import { describe, expect, it } from 'vitest';

import { checkBaseHealth } from './base-health.js';

async function resolvedRefs(baseRef?: string): Promise<{ commands: string[]; reason?: string }> {
  const commands: string[] = [];
  const result = await checkBaseHealth({
    worktree: '/wt',
    constitution: null,
    router: {} as never,
    env: {},
    log: () => {},
    ...(baseRef === undefined ? {} : { baseRef }),
    deps: {
      runCommand: async (cmd: readonly string[]) => {
        commands.push(cmd.join(' '));
        return { stdout: '', stderr: '', exitCode: 1 } as never;
      },
    },
  });
  return { commands, reason: result.reason };
}

describe('checkBaseHealth baseRef (#3764)', () => {
  it('resolves the base SHA from baseRef when set', async () => {
    const { commands, reason } = await resolvedRefs('origin/feat/x');
    expect(commands).toEqual(['git rev-parse --verify origin/feat/x^{commit}']);
    expect(reason).toBe('origin/feat/x not resolvable');
  });

  it('resolves origin/main when baseRef is omitted', async () => {
    const { commands, reason } = await resolvedRefs();
    expect(commands).toEqual(['git rev-parse --verify origin/main^{commit}']);
    expect(reason).toBe('origin/main not resolvable');
  });
});
