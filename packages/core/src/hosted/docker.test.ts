import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ExecFn } from '../utils/exec.js';
import { createDockerEngine } from './docker.js';
import { prepareGitHubAuthority, prototypeFallbackMint } from './github-authority.js';
import { createHostedJobStore } from './store.js';

async function fakeCredential(token = 'super-secret-tok') {
  const store = createHostedJobStore({ now: () => 1_000 });
  const job = store.create({
    jobId: 'job-1',
    repoSlug: 'owner/example-app',
    taskPayload: 'run the build',
    requiredCapabilities: ['git', 'node'],
    requiredAuthority: 'repo:write',
  });
  return prepareGitHubAuthority(job, { mint: prototypeFallbackMint(token), now: () => 1_000 });
}

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
    const { exec } = fakeExec(() => ({ stdout: 'abc123\n', stderr: '' }));
    const engine = createDockerEngine({ exec, rootDir: root });

    const workspace = await engine.prepareWorkspace('job-1', 'the payload', 'owner/example-app');

    expect(workspace.containerPayloadPath).toBe('/workspace/payload');
    expect(workspace.hostPath.startsWith(root)).toBe(true);
    const written = await readFile(join(workspace.hostPath, 'payload'), 'utf-8');
    expect(written).toBe('the payload');
  });

  it('clones the repo and resolves the HEAD commit as workspace identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec, calls } = fakeExec((call) =>
      call.cmd.startsWith('git -C') ? { stdout: 'abc123\n', stderr: '' } : { stdout: '', stderr: '' },
    );
    const engine = createDockerEngine({ exec, rootDir: root });

    const workspace = await engine.prepareWorkspace('job-1', 'the payload', 'owner/example-app');

    expect(calls[0]?.cmd).toBe(
      `git clone --depth 1 'https://github.com/owner/example-app.git' '${join(workspace.hostPath, 'repo')}'`,
    );
    expect(calls[1]?.cmd).toBe(`git -C '${join(workspace.hostPath, 'repo')}' rev-parse HEAD`);
    expect(workspace.clone).toEqual({ ok: true, commit: 'abc123' });
    expect(workspace.containerRepoPath).toBe('/workspace/repo');
  });

  it('builds the clone URL from an injected cloneUrlFor (auth-injection seam)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec, calls } = fakeExec(() => ({ stdout: 'abc123\n', stderr: '' }));
    const engine = createDockerEngine({
      exec,
      rootDir: root,
      cloneUrlFor: (slug) => `git@host:${slug}.git`,
    });

    await engine.prepareWorkspace('job-1', 'the payload', 'owner/example-app');

    expect(calls[0]?.cmd).toContain("'git@host:owner/example-app.git'");
  });

  it('reports a clone failure as data instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec } = fakeExec((call) => {
      if (call.cmd.startsWith('git clone')) {
        rejects({ stderr: 'fatal: repository not found' });
      }
      return { stdout: '', stderr: '' };
    });
    const engine = createDockerEngine({ exec, rootDir: root });

    const workspace = await engine.prepareWorkspace('job-1', 'the payload', 'owner/example-app');

    expect(workspace.clone.ok).toBe(false);
    expect(workspace.clone.error).toContain('repository not found');
  });

  it('clones through the credential remoteUrl and writes a .git-credentials mount when a bundle is given (#901)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec, calls } = fakeExec(() => ({ stdout: 'abc123\n', stderr: '' }));
    const engine = createDockerEngine({ exec, rootDir: root });
    const credential = await fakeCredential();

    const workspace = await engine.prepareWorkspace('job-1', 'the payload', 'owner/example-app', credential);

    expect(calls[0]?.cmd).toBe(`git clone --depth 1 '${credential.remoteUrl}' '${join(workspace.hostPath, 'repo')}'`);
    expect(calls[0]?.cmd).not.toContain('https://github.com/owner/example-app.git');
    const credentialFile = join(workspace.hostPath, '.git-credentials');
    const written = await readFile(credentialFile, 'utf-8');
    expect(written).toBe(`${credential.credentialLine}\n`);
  });

  it('redacts the token from a clone-error message when a credential bundle is given (#901)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const credential = await fakeCredential();
    const { exec } = fakeExec((call) => {
      if (call.cmd.startsWith('git clone')) {
        rejects({ stderr: `fatal: could not authenticate to ${credential.remoteUrl}` });
      }
      return { stdout: '', stderr: '' };
    });
    const engine = createDockerEngine({ exec, rootDir: root });

    const workspace = await engine.prepareWorkspace('job-1', 'the payload', 'owner/example-app', credential);

    expect(workspace.clone.ok).toBe(false);
    expect(workspace.clone.error).not.toContain(credential.token);
    expect(workspace.clone.error).toContain('[redacted]');
  });

  it('keeps the exact unauthenticated cloneUrlFor path when no credential is given', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec, calls } = fakeExec(() => ({ stdout: 'abc123\n', stderr: '' }));
    const engine = createDockerEngine({ exec, rootDir: root });

    const workspace = await engine.prepareWorkspace('job-1', 'the payload', 'owner/example-app');

    expect(calls[0]?.cmd).toBe(
      `git clone --depth 1 'https://github.com/owner/example-app.git' '${join(workspace.hostPath, 'repo')}'`,
    );
    await expect(stat(join(workspace.hostPath, '.git-credentials'))).rejects.toThrow();
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
    const { exec: prepExec } = fakeExec(() => ({ stdout: '', stderr: '' }));
    const engine = createDockerEngine({ exec: prepExec, rootDir: root });
    const workspace = await engine.prepareWorkspace('job-1', 'payload', 'owner/example-app');

    const { exec, calls } = fakeExec((call) =>
      call.cmd.startsWith('docker ps -a') ? { stdout: '', stderr: '' } : { stdout: '', stderr: '' },
    );
    const removeEngine = createDockerEngine({ exec, rootDir: root });

    const proof = await removeEngine.remove('job-1', workspace.hostPath);

    expect(calls[0]?.cmd).toBe("docker rm -f 'sf-job-job-1'");
    expect(calls[1]?.cmd).toBe("docker ps -a --filter 'name=sf-job-job-1' --format '{{.ID}}'");
    expect(proof.removed).toBe(true);
    expect(proof.workspaceRemoved).toBe(true);
    expect(proof.credentialRemoved).toBe(true);
    expect(proof.containerName).toBe('sf-job-job-1');

    await expect(stat(workspace.hostPath)).rejects.toThrow();
  });

  it('reports removed: false when docker ps -a still lists the container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-docker-test-'));
    const { exec } = fakeExec((call) =>
      call.cmd.startsWith('docker ps -a') ? { stdout: 'abc123', stderr: '' } : { stdout: '', stderr: '' },
    );
    const engine = createDockerEngine({ exec, rootDir: root });
    const workspace = await engine.prepareWorkspace('job-1', 'payload', 'owner/example-app');

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
    const workspace = await engine.prepareWorkspace('job-1', 'payload', 'owner/example-app');

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
    const workspace = await engine.prepareWorkspace('job-1', 'payload', 'owner/example-app');

    const proof = await engine.remove('job-1', workspace.hostPath);

    expect(proof.removed).toBe(false);
    expect(proof.evidence).toContain('ps -a check failed');
    expect(proof.evidence).toContain('docker daemon not running');
  });
});

describe('createDockerEngine.removeLaneContainer (#1686)', () => {
  it('force-removes by name with volumes, then proves absence via ps -a', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '', stderr: '' }));
    const engine = createDockerEngine({ exec });

    const proof = await engine.removeLaneContainer!('sf-job-run-1-review-pr-8');

    expect(calls.map((c) => c.cmd)).toEqual([
      "docker rm -f -v 'sf-job-run-1-review-pr-8'",
      "docker ps -a --filter 'name=sf-job-run-1-review-pr-8' --format '{{.ID}}'",
    ]);
    expect(proof).toEqual({
      containerName: 'sf-job-run-1-review-pr-8',
      removed: true,
      evidence: 'docker rm -f -v sf-job-run-1-review-pr-8 ok; ps -a empty',
    });
  });

  it('reports removed: false when docker ps -a still lists the container', async () => {
    const { exec } = fakeExec((call) =>
      call.cmd.startsWith('docker ps -a') ? { stdout: 'abc123', stderr: '' } : { stdout: '', stderr: '' },
    );

    const proof = await createDockerEngine({ exec }).removeLaneContainer!('c1');

    expect(proof.removed).toBe(false);
    expect(proof.evidence).toContain('ps -a still shows a match');
  });

  it('surfaces a docker rm rejection in evidence without throwing', async () => {
    const { exec } = fakeExec((call) => {
      if (call.cmd.startsWith('docker rm')) rejects({ code: 1, stderr: 'no such container' });
      return { stdout: '', stderr: '' };
    });

    const proof = await createDockerEngine({ exec }).removeLaneContainer!('c1');

    expect(proof.removed).toBe(true);
    expect(proof.evidence).toContain('no such container');
  });

  it('reports removed: false when the ps -a check itself fails', async () => {
    const { exec } = fakeExec((call) => {
      if (call.cmd.startsWith('docker ps -a')) rejects({ stderr: 'daemon down' });
      return { stdout: '', stderr: '' };
    });

    const proof = await createDockerEngine({ exec }).removeLaneContainer!('c1');

    expect(proof.removed).toBe(false);
    expect(proof.evidence).toContain('ps -a check failed: daemon down');
  });

  it('falls back to String(err) when the error carries no stderr', async () => {
    const exec: ExecFn = async () => {
      throw 'plain';
    };

    const proof = await createDockerEngine({ exec }).removeLaneContainer!('c1');

    expect(proof.removed).toBe(false);
    expect(proof.evidence).toContain('error: plain');
  });
});

describe('createDockerEngine.createLaneContainer', () => {
  it('creates (but does not start) a container carrying the factory.managed=true label', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: 'containerid123', stderr: '' }));
    const engine = createDockerEngine({ exec });

    const result = await engine.createLaneContainer('sf-job-run-1-my-lane');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe(
      "docker create --name 'sf-job-run-1-my-lane' --label 'factory.managed=true' 'node:20-alpine' 'tail' '-f' '/dev/null'",
    );
    expect(result).toEqual({ containerName: 'sf-job-run-1-my-lane' });
  });

  it('uses the configured laneImage instead of the default', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: 'containerid123', stderr: '' }));
    const engine = createDockerEngine({ exec, laneImage: 'ubuntu:24.04' });

    await engine.createLaneContainer('sf-job-run-2-other-lane');

    expect(calls[0]?.cmd).toContain("'ubuntu:24.04'");
  });
});

describe('createDockerEngine.execInLaneContainer (#1685)', () => {
  it('starts the container then execs the quoted command in the given cwd', async () => {
    const { exec, calls } = fakeExec((call) =>
      call.cmd.startsWith('docker exec') ? { stdout: 'out', stderr: 'err' } : { stdout: '', stderr: '' },
    );
    const engine = createDockerEngine({ exec });

    const result = await engine.execInLaneContainer?.('sf-job-run-1-review-pr-8', ['npm', 'run', "b'uild"], {
      cwd: '/workspace/repo',
      timeoutMs: 5_000,
    });

    expect(calls[0]?.cmd).toBe("docker start 'sf-job-run-1-review-pr-8'");
    expect(calls[1]?.cmd).toBe("docker exec -w '/workspace/repo' 'sf-job-run-1-review-pr-8' 'npm' 'run' 'b'\\''uild'");
    expect(calls[1]?.opts).toEqual({ timeoutMs: 5_000 });
    expect(result).toEqual({ exitCode: 0, output: 'outerr', timedOut: false });
  });

  it('maps a non-zero exit code and output', async () => {
    const { exec } = fakeExec((call) => {
      if (call.cmd.startsWith('docker exec')) rejects({ code: 3, stdout: 'so', stderr: 'se' });
      return { stdout: '', stderr: '' };
    });
    const engine = createDockerEngine({ exec });

    const result = await engine.execInLaneContainer?.('c', ['false'], { cwd: '/w', timeoutMs: 1 });

    expect(result).toEqual({ exitCode: 3, output: 'sose', timedOut: false });
  });

  it('maps a killed process to timedOut and a non-numeric code to exit 1', async () => {
    const { exec } = fakeExec((call) => {
      if (call.cmd.startsWith('docker exec')) rejects({ killed: true });
      return { stdout: '', stderr: '' };
    });
    const engine = createDockerEngine({ exec });

    const result = await engine.execInLaneContainer?.('c', ['sleep', '9'], { cwd: '/w', timeoutMs: 1 });

    expect(result).toEqual({ exitCode: 1, output: '', timedOut: true });
  });

  it('returns a docker start failure instead of throwing, and never execs', async () => {
    const { exec, calls } = fakeExec((call) => {
      if (call.cmd.startsWith('docker start')) rejects({ code: 125, stderr: 'no such container' });
      return { stdout: '', stderr: '' };
    });
    const engine = createDockerEngine({ exec });

    const result = await engine.execInLaneContainer?.('c', ['ls'], { cwd: '/w', timeoutMs: 1 });

    expect(result).toEqual({ exitCode: 125, output: 'no such container', timedOut: false });
    expect(calls.some((c) => c.cmd.startsWith('docker exec'))).toBe(false);
  });
});

describe('createDockerEngine.isAvailable', () => {
  it('resolves true when `docker info` succeeds', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '27.0.1\n', stderr: '' }));
    const engine = createDockerEngine({ exec });

    expect(await engine.isAvailable?.()).toBe(true);
    expect(calls[0]?.cmd.startsWith('docker info')).toBe(true);
  });

  it('resolves false when `docker info` fails', async () => {
    const exec: ExecFn = async () => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    const engine = createDockerEngine({ exec });

    expect(await engine.isAvailable?.()).toBe(false);
  });
});
