// src/hosted/docker.ts — Real ContainerEngine adapter for hosted-exec (#899),
// shelling `docker run` / `docker rm -f` / `docker ps` through the existing
// ExecFn seam. Every shell call goes through the injected exec function so
// tests never touch a real docker daemon.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultExecFn, type ExecFn } from '../utils/exec.js';
import type {
  CloneOutcome,
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
  /** Builds the clone URL for a repo slug; defaults to https://github.com/<slug>.git. */
  cloneUrlFor?: (repoSlug: string) => string;
  /** Subdir under the workspace the repo is cloned into; default 'repo'. */
  repoDirname?: string;
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
  const repoDirname = options.repoDirname ?? 'repo';
  const cloneUrlFor = options.cloneUrlFor ?? ((slug: string) => `https://github.com/${slug}.git`);

  return {
    async prepareWorkspace(_jobId, payload, repoSlug): Promise<PreparedWorkspace> {
      const dir = await mkdtemp(join(options.rootDir ?? tmpdir(), 'sf-job-'));
      await writeFile(join(dir, payloadFilename), payload, 'utf-8');

      const repoPath = join(dir, repoDirname);
      const cloneUrl = cloneUrlFor(repoSlug);
      let clone: CloneOutcome;
      try {
        await exec(`git clone --depth 1 ${quote(cloneUrl)} ${quote(repoPath)}`, {});
        const { stdout } = await exec(`git -C ${quote(repoPath)} rev-parse HEAD`, {});
        clone = { ok: true, commit: stdout.trim() };
      } catch (err) {
        const execErr = err as PromisifiedExecError;
        clone = { ok: false, error: execErr.stderr ?? (err instanceof Error ? err.message : String(err)) };
      }

      return {
        hostPath: dir,
        containerPayloadPath: `/workspace/${payloadFilename}`,
        containerRepoPath: `/workspace/${repoDirname}`,
        clone,
      };
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
      let psCheckError: string | undefined;
      try {
        const { stdout } = await exec(`docker ps -a --filter ${quote(`name=${name}`)} --format '{{.ID}}'`, {});
        removed = stdout.trim() === '';
      } catch (err) {
        const execErr = err as PromisifiedExecError;
        removed = false;
        psCheckError = execErr.stderr ?? String(err);
      }

      let workspaceRemoved: boolean;
      try {
        await rm(workspaceHostPath, { recursive: true, force: true });
        workspaceRemoved = true;
      } catch {
        workspaceRemoved = false;
      }

      const psCheckResult = psCheckError
        ? `ps -a check failed: ${psCheckError}`
        : `ps -a ${removed ? 'empty' : 'still shows a match'}`;
      const evidence = `${removeEvidence}; ${psCheckResult}; workspace ${workspaceRemoved ? 'removed' : 'removal failed'}`;
      return { containerName: name, removed, workspaceRemoved, evidence };
    },
  };
}
