import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { execGit } from '../utils/git-exec.js';
import type { KillOutcome } from '../environment/process-groups.js';
import { createEvidenceSideEffectsGuard } from './side-effects.js';
import type { CheckerContext } from './index.js';

const tempDirs = createTempDirs();
afterEach(async () => tempDirs.cleanup());

async function repository(): Promise<string> {
  const root = await tempDirs.make('side-effects-');
  await execGit(['init', '-q'], { cwd: root });
  await execGit(['config', 'user.name', 'test'], { cwd: root });
  await execGit(['config', 'user.email', 'test@example.com'], { cwd: root });
  await writeFile(join(root, 'tracked.txt'), 'base');
  await execGit(['add', 'tracked.txt'], { cwd: root });
  await execGit(['commit', '-qm', 'base'], { cwd: root });
  return root;
}

function context(worktree: string, killAll?: () => Promise<KillOutcome[]>): CheckerContext {
  return {
    worktree,
    specPath: join(worktree, 'issue.md'),
    processGroupTracker: killAll ? { killAll } : undefined,
  };
}

describe('evidence side effects guard', () => {
  it('side_effects fails on porcelain delta after evidence', async () => {
    const worktree = await repository();
    const guard = createEvidenceSideEffectsGuard(context(worktree));
    await guard.beforeCommand();
    await writeFile(join(worktree, 'leak.tmp'), 'leaked');
    await guard.afterCommand('npm test', []);
    const output = await guard.finish();
    expect(output).toMatchObject({ checker: 'side_effects', result: 'FAIL' });
    expect(output.details).toContain(JSON.stringify('leak.tmp'));
  });

  it('side_effects kills and fails when evidence pgid survives', async () => {
    const order: string[] = [];
    const guard = createEvidenceSideEffectsGuard(
      context('/tmp/lane', async () => {
        order.push('kill');
        return [];
      }),
      {
        readStatus: async () => '',
        isAlive: () => true,
      },
    );
    await guard.beforeCommand();
    order.push('settled');
    await guard.afterCommand('npm run lint', [42, 42]);
    const output = await guard.finish();
    expect(order).toEqual(['settled', 'kill']);
    expect(output).toMatchObject({ result: 'FAIL' });
    expect(output.details).toContain('npm run lint');
    expect(output.details).toContain('42');
  });

  it('side_effects passes for exempt delta and dead evidence groups', async () => {
    const worktree = await repository();
    await writeFile(join(worktree, '.gitignore'), 'ignored.tmp\n');
    const guard = createEvidenceSideEffectsGuard(context(worktree), { isAlive: () => false });
    await guard.beforeCommand();
    await mkdir(join(worktree, '.factory'), { recursive: true });
    await writeFile(join(worktree, '.factory', 'evidence.log'), 'ok');
    await writeFile(join(worktree, 'ignored.tmp'), 'ignored');
    await guard.afterCommand('npm test', [91]);
    await expect(guard.finish()).resolves.toMatchObject({ result: 'PASS' });
  });

  it('reports changed tracked status and ignores removed pre-existing records', async () => {
    const snapshots = [' M existing.txt\0 D removed.txt\0', 'MM existing.txt\0'];
    let index = 0;
    const guard = createEvidenceSideEffectsGuard(context('/tmp/lane'), {
      readStatus: async () => snapshots[index++]!,
    });
    await guard.beforeCommand();
    await guard.afterCommand('test', []);
    const output = await guard.finish();
    expect(output.details).toContain(JSON.stringify('existing.txt'));
    expect(output.details).not.toContain('removed.txt');
  });

  it('fails closed on malformed status and status read errors', async () => {
    const malformed = createEvidenceSideEffectsGuard(context('/tmp/lane'), { readStatus: async () => 'XX bad\0' });
    await expect(malformed.beforeCommand()).rejects.toThrow('unknown git status code');
    expect(await malformed.finish()).toMatchObject({ result: 'FAIL' });
    const unreadable = createEvidenceSideEffectsGuard(context('/tmp/lane'), {
      readStatus: async () => {
        throw new Error('git unavailable');
      },
    });
    await expect(unreadable.beforeCommand()).rejects.toThrow('git unavailable');
    expect(await unreadable.finish()).toMatchObject({ result: 'FAIL' });
  });

  it('handles rename and copy records with both NUL paths', async () => {
    const snapshots = ['', 'R  new name\0old name\0C  copy name\0source name\0'];
    let index = 0;
    const guard = createEvidenceSideEffectsGuard(context('/tmp/lane'), { readStatus: async () => snapshots[index++]! });
    await guard.beforeCommand();
    await guard.afterCommand('test', []);
    const output = await guard.finish();
    expect(output.details).toContain(JSON.stringify('new name'));
    expect(output.details).toContain(JSON.stringify('old name'));
    expect(output.details).toContain(JSON.stringify('copy name'));
    expect(output.details).toContain(JSON.stringify('source name'));
  });

  it('reports either non-exempt side of boundary renames and preserves unusual paths', async () => {
    const snapshots = ['', 'R  .factory/old\0outside\0?? tab\tnewline\narrow -> name\0?? .factory-other/file\0'];
    let index = 0;
    const guard = createEvidenceSideEffectsGuard(context('/tmp/lane'), {
      readStatus: async () => snapshots[index++]!,
    });
    await guard.beforeCommand();
    await guard.afterCommand('test', []);
    const output = await guard.finish();
    expect(output.details).toContain(JSON.stringify('outside'));
    expect(output.details).toContain(JSON.stringify('tab\tnewline\narrow -> name'));
    expect(output.details).not.toContain(JSON.stringify('.factory/old'));
    expect(output.details).toContain(JSON.stringify('.factory-other/file'));
  });

  it('reports probe, missing tracker, and cleanup failures for unique command groups', async () => {
    let kills = 0;
    const guard = createEvidenceSideEffectsGuard(
      context('/tmp/lane', async () => {
        kills++;
        throw new Error('cleanup failed');
      }),
      {
        readStatus: async () => '',
        isAlive: (pgid) => pgid === 10,
      },
    );
    await guard.beforeCommand();
    await guard.afterCommand('one', [10, 10, 11]);
    const output = await guard.finish();
    expect(kills).toBe(1);
    expect(output.details).toContain('live process group 10');
    expect(output.details).toContain('cleanup failed');

    const noTracker = createEvidenceSideEffectsGuard(context('/tmp/lane'), {
      readStatus: async () => '',
      isAlive: () => true,
    });
    await noTracker.beforeCommand();
    await noTracker.afterCommand('two', [20]);
    expect((await noTracker.finish()).details).toContain('no lane process tracker');
  });

  it('fails closed on unterminated status records', async () => {
    const guard = createEvidenceSideEffectsGuard(context('/tmp/lane'), {
      readStatus: async () => '?? file',
    });
    await expect(guard.beforeCommand()).rejects.toThrow('missing a NUL terminator');
    expect(await guard.finish()).toMatchObject({ result: 'FAIL' });
  });

  it('does no status or process work when inactive', async () => {
    const guard = createEvidenceSideEffectsGuard(context('/tmp/lane'), {
      readStatus: async () => {
        throw new Error('must not read');
      },
      isAlive: () => {
        throw new Error('must not probe');
      },
    });
    await expect(guard.finish()).resolves.toMatchObject({ result: 'SKIP' });
  });
});
