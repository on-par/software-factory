// src/hosted/docker.ts — Real ContainerEngine adapter for disposable-docker
// lanes (#1535, #1536), shelling `docker create` / `docker cp` and `git clone`
// through the existing ExecFn seam. Every shell call goes through the injected exec function so
// tests never touch a real docker daemon.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultExecFn, type ExecFn } from '../utils/exec.js';
import type { CloneOutcome, ContainerEngine, LaneContainerCreateResult, LaneWorkspacePrepared } from './container.js';

export interface DockerEngineOptions {
  /** Injectable for tests; defaults to defaultExecFn. */
  exec?: ExecFn;
  /** Root dir for the temporary host-side clone; defaults to os.tmpdir(). */
  rootDir?: string;
  /** Builds the clone URL for a repo slug; defaults to https://github.com/<slug>.git. */
  cloneUrlFor?: (repoSlug: string) => string;
  /** Subdir under the workspace the repo is cloned into; default 'repo'. */
  repoDirname?: string;
  /** Image for containers created by createLaneContainer; default 'node:20-alpine'. */
  laneImage?: string;
}

interface PromisifiedExecError {
  stderr?: string;
}

/** Applied to every container createLaneContainer creates, so cleanup sweeps can
 *  find factory-owned containers by label alone (#1535). */
const MANAGED_LABEL = 'factory.managed=true';

function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function createDockerEngine(options: DockerEngineOptions): ContainerEngine {
  const exec = options.exec ?? defaultExecFn;
  const repoDirname = options.repoDirname ?? 'repo';
  const cloneUrlFor = options.cloneUrlFor ?? ((slug: string) => `https://github.com/${slug}.git`);
  const laneImage = options.laneImage ?? 'node:20-alpine';

  return {
    async createLaneContainer(name): Promise<LaneContainerCreateResult> {
      await exec(`docker create --name ${quote(name)} --label ${quote(MANAGED_LABEL)} ${quote(laneImage)}`, {});
      return { containerName: name };
    },

    async prepareLaneWorkspace(targetContainerName, repoSlug): Promise<LaneWorkspacePrepared> {
      const containerRepoPath = `/workspace/${repoDirname}`;
      const tempDir = await mkdtemp(join(options.rootDir ?? tmpdir(), 'sf-lane-'));
      let clone: CloneOutcome;
      try {
        await exec(`git clone --depth 1 ${quote(cloneUrlFor(repoSlug))} ${quote(tempDir)}`, {});
        const { stdout } = await exec(`git -C ${quote(tempDir)} rev-parse HEAD`, {});
        clone = { ok: true, commit: stdout.trim() };
      } catch (err) {
        const execErr = err as PromisifiedExecError;
        clone = { ok: false, error: execErr.stderr ?? (err instanceof Error ? err.message : String(err)) };
      }
      if (clone.ok) {
        try {
          await exec(`docker cp ${quote(`${tempDir}/.`)} ${quote(`${targetContainerName}:${containerRepoPath}`)}`, {});
        } catch (err) {
          const execErr = err as PromisifiedExecError;
          clone = { ok: false, error: execErr.stderr ?? (err instanceof Error ? err.message : String(err)) };
        }
      }
      await rm(tempDir, { recursive: true, force: true });
      return { containerRepoPath, clone };
    },
  };
}
