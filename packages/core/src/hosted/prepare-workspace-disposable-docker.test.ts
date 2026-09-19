import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { ExecFn } from '../utils/exec.js';
import { createDockerEngine } from './docker.js';

const execFileAsync = promisify(execFile);

interface ExecCall {
  cmd: string;
}

function fakeExec(script: (call: ExecCall) => { stdout: string; stderr: string }) {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd) => {
    calls.push({ cmd });
    return script({ cmd });
  };
  return { exec, calls };
}

function rejects(props: { stderr?: string }): never {
  throw Object.assign(new Error('command failed'), props);
}

async function hostWorktreeList(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list']);
  return stdout;
}

describe('createDockerEngine.prepareLaneWorkspace (#1536)', () => {
  it('clones from the remote URL — never the host path — landing at containerRepoPath via docker cp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-lane-test-'));
    const { exec, calls } = fakeExec((call) =>
      call.cmd.startsWith('git -C') ? { stdout: 'deadbeef\n', stderr: '' } : { stdout: '', stderr: '' },
    );
    const engine = createDockerEngine({ exec, rootDir: root });

    const workspace = await engine.prepareLaneWorkspace('sf-job-run-1-my-lane', 'owner/example-app');

    const cloneCall = calls.find((c) => c.cmd.startsWith('git clone'));
    expect(cloneCall?.cmd).toContain("'https://github.com/owner/example-app.git'");
    expect(cloneCall?.cmd).not.toContain(process.cwd());

    const cpCall = calls.find((c) => c.cmd.startsWith('docker cp'));
    expect(cpCall?.cmd).toContain(`'sf-job-run-1-my-lane:/workspace/repo'`);
    expect(workspace.containerRepoPath).toBe('/workspace/repo');
    expect(workspace.clone).toEqual({ ok: true, commit: 'deadbeef' });
  });

  it('leaves the host git worktree list unchanged by the lane workspace prep', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-lane-test-'));
    const { exec } = fakeExec((call) =>
      call.cmd.startsWith('git -C') ? { stdout: 'deadbeef\n', stderr: '' } : { stdout: '', stderr: '' },
    );
    const engine = createDockerEngine({ exec, rootDir: root });

    const before = await hostWorktreeList();
    await engine.prepareLaneWorkspace('sf-job-run-1-my-lane', 'owner/example-app');
    const after = await hostWorktreeList();

    expect(after).toBe(before);
  });

  it('reports a clone failure as data instead of throwing, and never attempts docker cp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-lane-test-'));
    const { exec, calls } = fakeExec((call) => {
      if (call.cmd.startsWith('git clone')) {
        rejects({ stderr: 'fatal: repository not found' });
      }
      return { stdout: '', stderr: '' };
    });
    const engine = createDockerEngine({ exec, rootDir: root });

    const workspace = await engine.prepareLaneWorkspace('sf-job-run-1-my-lane', 'owner/example-app');

    expect(workspace.clone.ok).toBe(false);
    expect(workspace.clone.error).toContain('repository not found');
    expect(calls.some((c) => c.cmd.startsWith('docker cp'))).toBe(false);
  });

  it('reports a docker cp failure as data instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-lane-test-'));
    const { exec } = fakeExec((call) => {
      if (call.cmd.startsWith('git -C')) return { stdout: 'deadbeef\n', stderr: '' };
      if (call.cmd.startsWith('docker cp')) {
        rejects({ stderr: 'Error: No such container:path' });
      }
      return { stdout: '', stderr: '' };
    });
    const engine = createDockerEngine({ exec, rootDir: root });

    const workspace = await engine.prepareLaneWorkspace('sf-job-run-1-my-lane', 'owner/example-app');

    expect(workspace.clone.ok).toBe(false);
    expect(workspace.clone.error).toContain('No such container:path');
  });
});
