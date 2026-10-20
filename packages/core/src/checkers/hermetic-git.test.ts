import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { testsChecker } from './index.js';
import { checkPhase } from '../phases/check.js';
import { loadFactoryConfigForRepo } from '../config/index.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<{ root: string; artifact: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hermetic-git-checker-'));
  dirs.push(root);
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  const globalConfig = join(root, 'global.gitconfig');
  const systemConfig = join(root, 'system.gitconfig');
  const worktree = join(root, 'worktree');
  const artifact = join(root, 'probe.json');
  await Promise.all([home, xdg, worktree].map((path) => mkdir(path)));
  await writeFile(globalConfig, '[init]\n\tdefaultBranch = main\n[factory]\n\tglobalSentinel = host-global\n');
  await writeFile(systemConfig, '[factory]\n\tsystemSentinel = host-system\n');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', xdg);
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  vi.stubEnv('GIT_CONFIG_COUNT', '');
  vi.stubEnv('GIT_CONFIG_KEY_0', '');
  vi.stubEnv('GIT_CONFIG_VALUE_0', '');
  vi.stubEnv('GIT_CONFIG_PARAMETERS', '');
  const artifactPath = JSON.stringify(artifact);
  const script = `import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
const artifact = ${artifactPath};
const run = (args, cwd = root) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const get = (args, cwd = root) => { const r = run(args, cwd); return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() }; };
const result = {};
result.globalDefault = get(['config', '--global', '--get', 'init.defaultBranch']);
result.globalList = get(['config', '--global', '--list']);
result.hostGlobal = get(['config', '--global', '--get', 'factory.globalSentinel']);
result.hostSystem = get(['config', '--get', 'factory.systemSentinel']);
const origin = join(root, 'origin.git'); const source = join(root, 'source'); const clone = join(root, 'clone');
execFileSync('git', ['init', '--bare', origin], { stdio: 'ignore' });
execFileSync('git', ['init', '-b', 'main', source], { stdio: 'ignore' });
execFileSync('git', ['-C', source, 'config', 'user.name', 'Probe User']);
execFileSync('git', ['-C', source, 'config', 'user.email', 'probe@example.test']);
await import('node:fs/promises').then(({ writeFile }) => writeFile(join(source, 'file.txt'), 'committed'));
execFileSync('git', ['-C', source, 'add', 'file.txt']);
execFileSync('git', ['-C', source, 'commit', '-m', 'initial'], { stdio: 'ignore' });
execFileSync('git', ['-C', source, 'push', origin, 'main'], { stdio: 'ignore' });
const cloneResult = run(['clone', origin, clone]);
result.clone = { code: cloneResult.status, stderr: cloneResult.stderr.trim(), hasFile: (await import('node:fs')).existsSync(join(clone, 'file.txt')) };
const repo = join(root, 'repo'); execFileSync('git', ['init', repo], { stdio: 'ignore' });
execFileSync('git', ['-C', repo, 'config', 'user.name', 'local-user-sentinel']);
result.localList = get(['config', '--list'], repo);
await import('node:fs/promises').then(({ writeFile }) => writeFile(artifact, JSON.stringify(result)));
`;
  await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'node probe.mjs' } }));
  await writeFile(join(worktree, 'probe.mjs'), script);
  return { root: worktree, artifact };
}

async function runProbe(hermeticGit: boolean): Promise<Record<string, unknown>> {
  const { root, artifact } = await setup();
  await mkdir(join(root, '.factory'));
  await writeFile(join(root, '.factory', 'config.json'), JSON.stringify({ version: 2, check: { hermeticGit } }));
  const resolvedHermeticGit = loadFactoryConfigForRepo(join(root, '.factory', 'config.json')).check.hermeticGit;
  const control = await import('node:child_process').then(({ spawnSync }) =>
    spawnSync('git', ['config', '--global', '--get', 'factory.globalSentinel'], { encoding: 'utf8' }),
  );
  expect(control.stdout.trim()).toBe('host-global');
  const systemControl = await import('node:child_process').then(({ spawnSync }) =>
    spawnSync('git', ['config', '--get', 'factory.systemSentinel'], { encoding: 'utf8' }),
  );
  expect(systemControl.stdout.trim()).toBe('host-system');
  const result = await checkPhase({
    issue: 3272,
    worktree: root,
    specPath: join(root, 'spec.md'),
    router: {} as never,
    constitution: null,
    log: () => {},
    autoRework: false,
    hermeticGit: resolvedHermeticGit,
    runCheckers: async (ctx) => {
      const tests = await testsChecker(ctx);
      expect(tests.result).toBe('PASS');
      return { failures: 0, passes: 1, skips: 0, total: 1, results: [tests] };
    },
  });
  expect(result.passed).toBe(true);
  return JSON.parse(await readFile(artifact, 'utf8')) as Record<string, unknown>;
}

describe('checker subprocess Git configuration', () => {
  it('checker commands do not see the host global git config (#1886, PR #3265)', async () => {
    const result = await runProbe(true);
    expect(result.globalDefault).toEqual({ code: 1, stdout: '', stderr: '' });
    expect(result.globalList).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(result.hostGlobal).toEqual({ code: 1, stdout: '', stderr: '' });
    expect(result.hostSystem).toEqual({ code: 1, stdout: '', stderr: '' });
  });

  it('checker bare init and clone reproduce the unconfigured runner (#1886)', async () => {
    const result = await runProbe(true);
    expect(result.clone).toMatchObject({ code: 0, hasFile: false });
    expect((result.clone as { stderr: string }).stderr).toMatch(/remote HEAD refers to nonexistent ref/);
  });

  it('checker config lists local settings while excluding host global and system settings', async () => {
    const result = await runProbe(true);
    const local = result.localList as { stdout: string };
    expect(local.stdout).toContain('user.name=local-user-sentinel');
    expect(local.stdout).not.toContain('host-global');
    expect(local.stdout).not.toContain('host-system');
  });

  it('an explicit opt-out retains inherited global and system Git config', async () => {
    const result = await runProbe(false);
    expect(result.globalDefault).toMatchObject({ code: 0, stdout: 'main' });
    expect(result.hostGlobal).toMatchObject({ code: 0, stdout: 'host-global' });
    expect(result.hostSystem).toMatchObject({ code: 0, stdout: 'host-system' });
  });
});
