import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createDockerEngine, type ContainerEngine } from '@on-par/factory-core/internal';

export interface DockerProbeStatus {
  cli: boolean;
  daemon: boolean;
}

async function dockerCliPresent(): Promise<boolean> {
  try {
    await promisify(execFile)('docker', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Probes the Docker CLI (`docker --version`) and, only when it exists, the daemon via the
 *  ContainerEngine.isAvailable port (`docker info`). Never throws. An absent probe means
 *  unavailable (ADR-0114). */
export async function probeDocker(
  deps: { cliPresent?: () => Promise<boolean>; engine?: Pick<ContainerEngine, 'isAvailable'> } = {},
): Promise<DockerProbeStatus> {
  const cli = await (deps.cliPresent ?? dockerCliPresent)().catch(() => false);
  if (!cli) return { cli: false, daemon: false };
  const engine = deps.engine ?? createDockerEngine({});
  try {
    return { cli: true, daemon: (await engine.isAvailable?.()) === true };
  } catch {
    return { cli: true, daemon: false };
  }
}

export function dockerWorkspacePreflightError(probe: DockerProbeStatus): string | null {
  if (!probe.cli) {
    return 'workspace.mode is docker but the Docker CLI was not found on PATH. Install Docker, or set workspace.mode: worktree. Not falling back to a worktree.';
  }
  if (!probe.daemon) {
    return 'workspace.mode is docker but the Docker daemon is unreachable (docker info failed). Start Docker, or set workspace.mode: worktree. Not falling back to a worktree.';
  }
  return null;
}
