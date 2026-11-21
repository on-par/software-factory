import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadModelsConfig, loadRoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { buildPhase } from './build.js';

const dirs = createTempDirs();

afterEach(async () => {
  await dirs.cleanup();
});

describe('buildPhase copilot route', () => {
  it('runs build_copilot with the commit-only prompt and the pinned Copilot model', async () => {
    const worktree = await dirs.make('build-phase-copilot-');
    const stub = new StubModelExecutor({ scripts: { build_copilot: [{ output: 'copilot output' }] } });
    const result = await buildPhase({
      issue: workKeyFromIssue(41),
      repo: 'acme/widgets',
      worktree,
      specPath: join(worktree, 'issue-41.md'),
      branch: 'factory/41-copilot',
      route: 'copilot',
      router: new ModelRouter(loadModelsConfig(), loadRoutesConfig(), false, stub, true),
      constitution: null,
      log: () => {},
      modelOverride: 'copilot-default',
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe('copilot');
    expect(stub.calls.map((c) => [c.task, c.model])).toEqual([['build_copilot', 'copilot-default']]);
    expect(stub.calls[0]?.prompt).toMatch(/^Implement issue #/);
  });
});
