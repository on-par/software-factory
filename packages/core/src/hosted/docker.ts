// src/hosted/docker.ts — Real ContainerEngine adapter for hosted-exec (#899),
// shelling `docker run` / `docker rm -f` / `docker ps` through the existing
// ExecFn seam. Every shell call goes through the injected exec function so
// tests never touch a real docker daemon.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultExecFn, type ExecFn } from '../utils/exec.js';
import type {
  ContainerCleanupProof,
  ContainerEngine,
  ContainerRunResult,
  ContainerRunSpec,
  PreparedWorkspace,
} from './container.js';

export interface DockerEngineOptions {
  /** Injectable for tests; defaults to defaultExecFn. */
  exec?: ExecFn;
  /** Root dir for per-job workspaces; defaults to os.tmpdir(). */
  rootDir?: string;
  /** Filename for the payload inside the workspace; default 'payload'. */
  payloadFilename?: string;
}

interface PromisifiedExecError {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

const containerName = (jobId: string) => `sf-job-${jobId}`;

function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function createDockerEngine(options: DockerEngineOptions): ContainerEngine {
  const exec = options.exec ?? defaultExecFn;
  const payloadFilename = options.payloadFilename ?? 'payload';

  return {
    async prepareWorkspace(_jobId, payload): Promise<PreparedWorkspace> {
      const dir = await mkdtemp(join(options.rootDir ?? tmpdir(), 'sf-job-'));
      await writeFile(join(dir, payloadFilename), payload, 'utf-8');
      return { hostPath: dir, containerPayloadPath: `/workspace/${payloadFilename}` };
    },

    async run(spec: ContainerRunSpec): Promise<ContainerRunResult> {
      const name = containerName(spec.jobId);
      const cmd = [
        'docker run',
        `--name ${quote(name)}`,
        `-v ${quote(`${spec.workspaceHostPath}:${spec.mountPath}`)}`,
        quote(spec.image),
        ...spec.command.map(quote),
      ].join(' ');
      try {
        const { stdout, stderr } = await exec(cmd, { timeoutMs: spec.timeoutMs });
        return { containerName: name, exitCode: 0, logs: stdout + stderr, timedOut: false };
      } catch (err) {
        const execErr = err as PromisifiedExecError;
        const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
        return {
          containerName: name,
          exitCode,
          logs: (execErr.stdout ?? '') + (execErr.stderr ?? ''),
          timedOut: execErr.killed === true,
        };
      }
    },

    async remove(jobId, workspaceHostPath): Promise<ContainerCleanupProof> {
      const name = containerName(jobId);
      let removeEvidence: string;
      try {
        await exec(`docker rm -f ${quote(name)}`, {});
        removeEvidence = `docker rm -f ${name} ok`;
      } catch (err) {
        const execErr = err as PromisifiedExecError;
        removeEvidence = `docker rm -f ${name} error: ${execErr.stderr ?? String(err)}`;
      }

      let removed = false;
      try {
        const { stdout } = await exec(`docker ps -a --filter ${quote(`name=${name}`)} --format '{{.ID}}'`, {});
        removed = stdout.trim() === '';
      } catch {
        removed = false;
      }

      let workspaceRemoved: boolean;
      try {
        await rm(workspaceHostPath, { recursive: true, force: true });
        workspaceRemoved = true;
      } catch {
        workspaceRemoved = false;
      }

      const evidence = `${removeEvidence}; ps -a ${removed ? 'empty' : 'still shows a match'}; workspace ${workspaceRemoved ? 'removed' : 'removal failed'}`;
      return { containerName: name, removed, workspaceRemoved, evidence };
    },
  };
}
