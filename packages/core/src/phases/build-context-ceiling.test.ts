import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { buildPhase } from './build.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

describe('buildPhase context_ceiling event', () => {
  it('logs a context_ceiling event when the router reports a ceiling (#3327)', async () => {
    const worktree = await tempDirs.make('build-phase-test-');
    const fakeRouter = {
      run: async (_task: string, _prompt: string, options: any) => {
        options.onContextCeiling({ task: 'build_codex', model: 'm', harness: 'codex-cli', value: 90000 });
        return { model: 'm', output: 'done', exitCode: 0, attempts: [] };
      },
    } as any;
    const logs: Array<{ type: string; msg: string }> = [];
    await buildPhase({
      issue: 3327,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-3327.md'),
      branch: 'ship-it/3327-x',
      route: 'codex',
      router: fakeRouter,
      constitution: null,
      log: (type: string, msg: string) => logs.push({ type, msg }),
      runId: 'r1',
    });
    expect(logs).toContainEqual({
      type: 'context_ceiling',
      msg: 'context ceiling 90000 for build_codex (codex-cli, m)',
    });
  });
});
