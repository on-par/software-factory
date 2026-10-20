import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkPhase } from './check.js';

const dirs: string[] = [];
const green = { failures: 0, passes: 0, skips: 0, total: 0, results: [] };

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function worktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'check-hermetic-'));
  dirs.push(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
  return dir;
}

describe('CHECK hermetic Git policy', () => {
  it.each([
    ['absent', undefined, true],
    ['explicit true', true, true],
    ['explicit false', false, false],
  ])('sets the checker environment for %s', async (_label, hermeticGit, enabled) => {
    const root = await worktree();
    let env: Record<string, string> | undefined;
    const log = vi.fn();
    await checkPhase({
      issue: 3272,
      worktree: root,
      specPath: join(root, 'spec.md'),
      router: {} as never,
      constitution: null,
      log,
      autoRework: false,
      hermeticGit,
      runCheckers: async (ctx) => {
        env = ctx.env;
        return green;
      },
    });
    expect(env?.GIT_CONFIG_GLOBAL).toBe(enabled ? '/dev/null' : undefined);
    expect(env?.GIT_CONFIG_NOSYSTEM).toBe(enabled ? '1' : undefined);
    expect(
      log.mock.calls.filter(([, message]) =>
        String(message).includes(`round 0, hermetic git: ${enabled ? 'on' : 'off'}`),
      ),
    ).toHaveLength(1);
  });

  it('isolates checker rounds while the rework worker and surrounding commands retain host config', async () => {
    const root = await worktree();
    const hostConfig = join(root, 'host.gitconfig');
    await writeFile(hostConfig, '[factory]\n\tglobalSentinel = host-config\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', hostConfig);
    const inherited = { ...process.env };
    const beforeCheck = spawnSync('git', ['config', '--global', '--get', 'factory.globalSentinel'], {
      encoding: 'utf8',
    });
    expect(beforeCheck.stdout.trim()).toBe('host-config');
    const contexts: Array<Record<string, string> | undefined> = [];
    const log = vi.fn();
    let calls = 0;
    const result = await checkPhase({
      issue: 3272,
      worktree: root,
      specPath: join(root, 'spec.md'),
      router: {
        run: async (_route: string, _prompt: string, options: { env?: Record<string, string> }) => {
          const probe = spawnSync('git', ['config', '--global', '--get', 'factory.globalSentinel'], {
            encoding: 'utf8',
            env: { ...process.env, ...options.env },
          });
          expect(probe.stdout.trim()).toBe('host-config');
          return { model: 'test', output: 'fixed', exitCode: 0, attempts: [] };
        },
      } as never,
      constitution: null,
      log,
      runCheckers: async (ctx) => {
        contexts.push(ctx.env);
        calls++;
        return calls === 1
          ? {
              failures: 1,
              passes: 0,
              skips: 0,
              total: 1,
              results: [{ checker: 'tests', result: 'FAIL', details: 'repair' }],
            }
          : green;
      },
    });
    expect(result.passed).toBe(true);
    expect(contexts).toHaveLength(2);
    expect(contexts.every((env) => env?.GIT_CONFIG_GLOBAL === '/dev/null' && env.GIT_CONFIG_NOSYSTEM === '1')).toBe(
      true,
    );
    expect(log.mock.calls.filter(([, message]) => String(message).includes('hermetic git: on'))).toHaveLength(2);
    const afterCheck = spawnSync('git', ['config', '--global', '--get', 'factory.globalSentinel'], {
      encoding: 'utf8',
    });
    expect(afterCheck.stdout.trim()).toBe('host-config');
    expect(process.env).toEqual(inherited);
  });
});
