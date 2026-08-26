import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ExecFn } from '../utils/exec.js';
import { createDockerEngine } from './docker.js';

interface ExecCall {
  cmd: string;
  opts: Parameters<ExecFn>[1];
}

function fakeExec(script: (call: ExecCall) => { stdout: string; stderr: string }) {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, opts) => {
    calls.push({ cmd, opts });
    return script({ cmd, opts });
  };
  return { exec, calls };
}

function rejects(props: { code?: number; killed?: boolean; stdout?: string; stderr?: string }): never {
  const err = Object.assign(new Error('command failed'), props);
  throw err;
}

describe('createDockerEngine.prepareWorkspace', () => {
  it('writes the payload to a temp dir and reports the container path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec } = fakeExec(() => ({ stdout: '', stderr: '' }));
    const engine = createDockerEngine({ exec, rootDir: root });

    const workspace = await engine.prepareWorkspace('job-1', 'the payload');

    expect(workspace.containerPayloadPath).toBe('/workspace/payload');
    expect(workspace.hostPath.startsWith(root)).toBe(true);
    const written = await readFile(join(workspace.hostPath, 'payload'), 'utf-8');
    expect(written).toBe('the payload');
  });
});

describe('createDockerEngine.run', () => {
  it('builds the docker run command with name, mount, image, and command', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: 'ok', stderr: '' }));
    const engine = createDockerEngine({ exec });

    const result = await engine.run({
      jobId: 'job-1',
      image: 'alpine:3.20',
      command: ['true'],
      workspaceHostPath: '/tmp/host-dir',
      mountPath: '/workspace',
      timeoutMs: 5_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("docker run --name 'sf-job-job-1' -v '/tmp/host-dir:/workspace' 'alpine:3.20' 'true'");
    expect(calls[0]?.opts).toMatchObject({ timeoutMs: 5_000 });
    expect(result).toEqual({ containerName: 'sf-job-job-1', exitCode: 0, logs: 'ok', timedOut: false });
  });

  it('maps a rejected exec with a numeric code to that exitCode without throwing', async () => {
    const { exec } = fakeExec(() => rejects({ code: 3, stdout: 'partial', stderr: 'boom' }));
    const engine = createDockerEngine({ exec });

    const result = await engine.run({
      jobId: 'job-1',
      image: 'alpine:3.20',
      command: ['false'],
      workspaceHostPath: '/tmp/host-dir',
      mountPath: '/workspace',
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ containerName: 'sf-job-job-1', exitCode: 3, logs: 'partialboom', timedOut: false });
  });

  it('maps a rejected exec with killed: true to timedOut: true', async () => {
    const { exec } = fakeExec(() => rejects({ killed: true, stdout: '', stderr: '' }));
    const engine = createDockerEngine({ exec });

    const result = await engine.run({
      jobId: 'job-1',
      image: 'alpine:3.20',
      command: ['sleep', '9999'],
      workspaceHostPath: '/tmp/host-dir',
      mountPath: '/workspace',
      timeoutMs: 5_000,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  });
});

describe('createDockerEngine.remove', () => {
  it('force-removes by name, checks ps -a, and deletes the workspace dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const engine = createDockerEngine({});
    const workspace = await engine.prepareWorkspace('job-1', 'payload');

    const { exec, calls } = fakeExec((call) =>
      call.cmd.startsWith('docker ps -a') ? { stdout: '', stderr: '' } : { stdout: '', stderr: '' },
    );
    const removeEngine = createDockerEngine({ exec, rootDir: root });

    const proof = await removeEngine.remove('job-1', workspace.hostPath);

    expect(calls[0]?.cmd).toBe("docker rm -f 'sf-job-job-1'");
    expect(calls[1]?.cmd).toBe("docker ps -a --filter 'name=sf-job-job-1' --format '{{.ID}}'");
    expect(proof.removed).toBe(true);
    expect(proof.workspaceRemoved).toBe(true);
    expect(proof.containerName).toBe('sf-job-job-1');

    await expect(stat(workspace.hostPath)).rejects.toThrow();
  });

  it('reports removed: false when docker ps -a still lists the container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec } = fakeExec((call) =>
      call.cmd.startsWith('docker ps -a') ? { stdout: 'abc123', stderr: '' } : { stdout: '', stderr: '' },
    );
    const engine = createDockerEngine({ exec, rootDir: root });
    const workspace = await engine.prepareWorkspace('job-1', 'payload');

    const proof = await engine.remove('job-1', workspace.hostPath);

    expect(proof.removed).toBe(false);
  });

  it('tolerates a docker rm -f rejection (e.g. no such container) and still checks ps -a', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec } = fakeExec((call) => {
      if (call.cmd.startsWith('docker rm -f')) {
        rejects({ code: 1, stderr: 'no such container' });
      }
      return { stdout: '', stderr: '' };
    });
    const engine = createDockerEngine({ exec, rootDir: root });
    const workspace = await engine.prepareWorkspace('job-1', 'payload');

    const proof = await engine.remove('job-1', workspace.hostPath);

    expect(proof.removed).toBe(true);
    expect(proof.evidence).toContain('no such container');
  });

  it('reports removed: false and surfaces the error when docker ps -a itself fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec } = fakeExec((call) => {
      if (call.cmd.startsWith('docker ps -a')) {
        rejects({ stderr: 'docker daemon not running' });
      }
      return { stdout: '', stderr: '' };
    });
    const engine = createDockerEngine({ exec, rootDir: root });
    const workspace = await engine.prepareWorkspace('job-1', 'payload');

    const proof = await engine.remove('job-1', workspace.hostPath);

    expect(proof.removed).toBe(false);
    expect(proof.evidence).toContain('ps -a check failed');
    expect(proof.evidence).toContain('docker daemon not running');
  });
});
