import { workKeyFromIssue } from '../work/work-key.js';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { execGit } from '../utils/git-exec.js';
import type { EventKind } from '../events/kinds.js';
import type { CheckSummary } from '../types/index.js';
import { checkPhase } from './check.js';
import { markBuildFilesIntentToAdd } from './check-intent-to-add.js';

const tempDirs = createTempDirs();
afterEach(async () => tempDirs.cleanup());

const passingSummary: CheckSummary = {
  failures: 0,
  passes: 1,
  skips: 0,
  total: 1,
  results: [{ checker: 'compile', result: 'PASS', details: 'ok' }],
};

const failingSummary: CheckSummary = {
  failures: 1,
  passes: 0,
  skips: 0,
  total: 1,
  results: [{ checker: 'compile', result: 'FAIL', details: 'repair required' }],
};

const models: ModelsConfig = {
  version: 1,
  models: {
    stub: {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub'] },
  failover: { triggers: ['error'], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};
const routes: RoutesConfig = {
  version: 1,
  routes: { build_claude: { tier: 'boss', description: 'test' } },
};

async function committedWorktree(): Promise<{ worktree: string; specPath: string; head: string }> {
  const worktree = await tempDirs.make('check-intent-to-add-');
  await execGit(['init', '-q'], { cwd: worktree });
  await execGit(['config', 'user.name', 'Factory Test'], { cwd: worktree });
  await execGit(['config', 'user.email', 'factory-test@example.invalid'], { cwd: worktree });
  await mkdir(join(worktree, 'packages/x/src'), { recursive: true });
  await writeFile(join(worktree, 'packages/x/src/existing.test.ts'), 'export {}\n');
  const specPath = join(worktree, 'issue.md');
  await writeFile(specPath, '# Test issue\n');
  await execGit(['add', '-A'], { cwd: worktree });
  await execGit(['commit', '-qm', 'initial'], { cwd: worktree });
  const head = (await execGit(['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim();
  return { worktree, specPath, head };
}

function logCollector(): { events: Array<[EventKind, string]>; log: (type: EventKind, msg: string) => void } {
  const events: Array<[EventKind, string]> = [];
  return { events, log: (type, msg) => events.push([type, msg]) };
}

describe('markBuildFilesIntentToAdd', () => {
  it('does not log a success event when there are no candidates', async () => {
    const { worktree } = await committedWorktree();
    const { events, log } = logCollector();
    await markBuildFilesIntentToAdd(worktree, log);
    expect(events).toEqual([]);
    await markBuildFilesIntentToAdd(worktree, log);
    expect(events).toEqual([]);
  });

  it('logs at most ten candidates and escapes unusual filenames', async () => {
    const { worktree } = await committedWorktree();
    for (let index = 0; index < 11; index++) await writeFile(join(worktree, `new ${index}.ts`), '');
    await writeFile(join(worktree, '-leading\tname.ts'), '');
    await writeFile(join(worktree, 'line\nname.ts'), '');
    const { events, log } = logCollector();
    await markBuildFilesIntentToAdd(worktree, log);
    const message = events[0]?.[1] ?? '';
    expect(events).toHaveLength(1);
    expect(message).toContain('(+3 more)');
    expect(message).toContain('"-leading\\tname.ts"');
    expect(message).toContain('"line\\nname.ts"');
    expect((message.match(/"new /g) ?? []).length).toBeLessThanOrEqual(10);
  });

  it('marks empty files and removes deleted intent-to-add paths from enumeration', async () => {
    const { worktree } = await committedWorktree();
    const emptyPath = join(worktree, 'empty.ts');
    await writeFile(emptyPath, '');
    await markBuildFilesIntentToAdd(worktree, () => {});
    expect((await execGit(['ls-files', '--', 'empty.ts'], { cwd: worktree })).stdout).toContain('empty.ts');
    await unlink(emptyPath);
    await markBuildFilesIntentToAdd(worktree, () => {});
    expect((await execGit(['ls-files', '--', 'empty.ts'], { cwd: worktree })).stdout).toBe('');
  });

  it('attempts index preparation after candidate listing fails', async () => {
    const { events, log } = logCollector();
    await markBuildFilesIntentToAdd('/missing/worktree/3271', log);
    expect(events.filter(([type]) => type === 'warn')).toHaveLength(2);
    expect(events[0]?.[1]).toContain('could not list untracked files');
    expect(events[1]?.[1]).toContain('git add --intent-to-add --all failed');
  });
});

describe('checkPhase intent-to-add preparation', () => {
  it('new untracked files are visible to git ls-files during CHECK (#1886, PR #3265)', async () => {
    const { worktree, specPath, head } = await committedWorktree();
    const newFile = join(worktree, 'packages/x/src/new.test.ts');
    await writeFile(newFile, 'export {}\n');
    let listed = '';
    const { log } = logCollector();
    const result = await checkPhase({
      issue: workKeyFromIssue(3271),
      worktree,
      specPath,
      router: new ModelRouter(models, routes, false, new StubModelExecutor({ defaultOutput: 'ok' })),
      constitution: null,
      log,
      runCheckers: async (ctx) => {
        listed = (await execGit(['ls-files', 'packages'], { cwd: ctx.worktree })).stdout;
        return passingSummary;
      },
    });
    expect(result.passed).toBe(true);
    expect(listed).toContain('packages/x/src/new.test.ts');
    expect((await execGit(['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim()).toBe(head);
    expect(await readFile(newFile, 'utf8')).toBe('export {}\n');
    await execGit(['diff', '--cached', '--quiet'], { cwd: worktree });
  });

  it('CHECK lists eligible new files while excluding ignored untracked files', async () => {
    const { worktree, specPath } = await committedWorktree();
    await writeFile(join(worktree, '.gitignore'), 'ignored.tmp\n');
    await execGit(['add', '.gitignore'], { cwd: worktree });
    await execGit(['commit', '-qm', 'ignore generated file'], { cwd: worktree });
    await writeFile(join(worktree, 'ignored.tmp'), 'ignored');
    await writeFile(join(worktree, 'eligible.ts'), 'eligible');
    let listed = '';
    await checkPhase({
      issue: workKeyFromIssue(3271),
      worktree,
      specPath,
      router: new ModelRouter(models, routes, false, new StubModelExecutor({ defaultOutput: 'ok' })),
      constitution: null,
      log: () => {},
      runCheckers: async () => {
        listed = (await execGit(['ls-files', '-z'], { cwd: worktree })).stdout;
        return passingSummary;
      },
    });
    expect(listed).toContain('eligible.ts');
    expect(listed).not.toContain('ignored.tmp');
  });

  it('prepares files created by the rework worker before the next checker round', async () => {
    const { worktree, specPath } = await committedWorktree();
    const original = join(worktree, 'first.ts');
    await writeFile(original, 'first');
    const executor = new StubModelExecutor({
      scripts: {
        build_claude: [{ output: 'repaired', effect: async () => writeFile(join(worktree, 'second.ts'), 'second') }],
      },
    });
    const router = new ModelRouter(models, routes, false, executor);
    const listedByRound: string[] = [];
    const { events, log } = logCollector();
    let round = 0;
    const result = await checkPhase({
      issue: workKeyFromIssue(3271),
      worktree,
      specPath,
      router,
      constitution: null,
      log,
      reworkRoute: 'claude',
      runCheckers: async (ctx) => {
        listedByRound.push((await execGit(['ls-files', '-z'], { cwd: ctx.worktree })).stdout);
        round++;
        return round === 1 ? failingSummary : passingSummary;
      },
    });
    expect(result.passed).toBe(true);
    expect(listedByRound).toHaveLength(2);
    expect(listedByRound[1]).toContain('first.ts');
    expect(listedByRound[1]).toContain('second.ts');
    expect(events.filter(([, message]) => message.includes('first.ts'))).toHaveLength(1);
  });

  it('a locked index warns and still runs CHECK checkers', async () => {
    const { worktree, specPath } = await committedWorktree();
    await writeFile(join(worktree, '.git/index.lock'), 'locked');
    await writeFile(join(worktree, 'eligible.ts'), 'eligible');
    const { events, log } = logCollector();
    let checkerRan = false;
    const result = await checkPhase({
      issue: workKeyFromIssue(3271),
      worktree,
      specPath,
      router: new ModelRouter(models, routes, false, new StubModelExecutor({ defaultOutput: 'ok' })),
      constitution: null,
      log,
      runCheckers: async () => {
        checkerRan = true;
        return passingSummary;
      },
    });
    expect(result.passed).toBe(true);
    expect(checkerRan).toBe(true);
    expect(
      events.some(([type, message]) => type === 'warn' && message.includes('git add --intent-to-add --all failed')),
    ).toBe(true);
    expect(events.some(([, message]) => message.includes('marked build files intent-to-add'))).toBe(false);
  });
});
