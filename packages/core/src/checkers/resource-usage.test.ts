import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConstitutionLoader } from '../constitutions/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { recordingLog, type LoggedEvent } from '../test-support/recorders.js';
import { makeStubModelsConfig, makeStubRoutesConfig } from '../test-support/index.js';
import { createTempWorktrees } from '../test-support/temp-worktree.js';
import { runAllCheckers } from './index.js';

const { makeWorktree, cleanup } = createTempWorktrees('checker-resource-');
const tempDirs = createTempDirs();

afterEach(async () => {
  await cleanup();
  await tempDirs.cleanup();
});

describe('runAllCheckers resource usage', () => {
  it('checker_completed carries cpuMs and peakRssBytes for every checker', async () => {
    const constitutionDir = await tempDirs.make('checker-resource-constitution-');
    await writeFile(
      join(constitutionDir, 'myproduct.md'),
      '---\nproduct: myproduct\ncheckers:\n  - not_a_real_checker\n---\nBody standard text\n',
    );
    const worktree = await makeWorktree();
    const router = new ModelRouter(
      makeStubModelsConfig(),
      makeStubRoutesConfig(),
      false,
      new StubModelExecutor({ scripts: {} }),
    );
    const constitution = new ConstitutionLoader(constitutionDir).resolve(worktree, 'myproduct');
    const events: LoggedEvent[] = [];

    await runAllCheckers(
      { worktree, specPath: join(worktree, 'no-such-spec.md'), constitutionBody: 'x', log: recordingLog(events) },
      router,
      constitution,
    );

    const completed = events.filter((e) => e.type === 'checker_completed');
    expect(completed.length).toBeGreaterThan(0);
    for (const event of completed) {
      expect(event.data?.cpuMs).toEqual(expect.any(Number));
      expect(event.data?.cpuMs as number).toBeGreaterThanOrEqual(0);
      expect(event.data?.peakRssBytes as number).toBeGreaterThan(0);
    }
  });
});
