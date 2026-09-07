import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it, vi } from 'vitest';

import { preflightPublication } from './publication-preflight.js';
import { defaultExecFn } from '../utils/exec.js';

const execFile = promisify(execFileCb);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('bounds a stalled transport and prevents credential prompts', async () => {
  const exec = vi.fn((_command, options) => defaultExecFn('sleep 30', options));
  const started = Date.now();
  await expect(preflightPublication({ cwd: tmpdir(), branch: 'factory/fixture', exec, timeoutMs: 75 })).rejects.toThrow(
    'Git publication preflight timed out',
  );
  expect(Date.now() - started).toBeLessThan(2000);
  expect(exec.mock.calls[0][1]).toMatchObject({
    timeoutMs: 75,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_ASKPASS: '/usr/bin/false',
      SSH_ASKPASS: '/usr/bin/false',
      SSH_ASKPASS_REQUIRE: 'force',
    },
  });
});

it.each(['https://user:private-token@example.invalid/repo', 'git@example.invalid:repo'])(
  'reports an actionable publication failure without echoing transport credentials (%s)',
  async (remote) => {
    const exec = vi.fn().mockRejectedValue(new Error(`fatal: ${remote} rejected Authorization: Bearer private-secret`));
    await expect(preflightPublication({ cwd: tmpdir(), branch: 'factory/fixture', exec })).rejects.toThrow(
      'Git publication preflight failed. Check origin push access and the Git credential helper or SSH identity on this computer; GitHub API login alone does not establish push access.',
    );
  },
);

it('checks receive-pack access without creating a remote feature ref or local tracking config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'publication-preflight-'));
  directories.push(root);
  const remote = join(root, 'remote.git');
  const cwd = join(root, 'work');
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['init', cwd]);
  await writeFile(join(cwd, 'readme.md'), 'fixture');
  await execFile('git', ['add', '.'], { cwd });
  await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], {
    cwd,
  });
  await execFile('git', ['remote', 'add', 'origin', remote], { cwd });
  const before = await execFile('git', ['ls-remote', 'origin'], { cwd });
  await preflightPublication({ cwd, branch: 'factory/fixture' });
  const after = await execFile('git', ['ls-remote', 'origin'], { cwd });
  expect(after.stdout).toBe(before.stdout);
  await expect(execFile('git', ['config', '--get', 'branch.factory/fixture.remote'], { cwd })).rejects.toThrow();
});
