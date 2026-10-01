import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  createDockerEngine,
  resolveWorkspaceMode,
  workspaceSandboxWarning,
  type ContainerEngine,
  type EffectiveWorkspaceMode,
} from '@on-par/factory-core/internal';
import type { loadFactoryConfigForRepo } from '@on-par/factory-core';

type FactoryConfig = ReturnType<typeof loadFactoryConfigForRepo>;

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

export type WorkspaceGate =
  | { kind: 'worktree'; warning: null }
  | { kind: 'invalid' | 'preflight-failed' | 'docker-unavailable'; message: string; warning: string | null };

/** Decides what `factory run` does about the workspace mode before any claim: proceed in a
 *  worktree, or stop (invalid env, failed Docker preflight, or docker pipeline not yet built).
 *  Never falls back to a worktree in docker mode. */
export async function workspaceGate(
  config: FactoryConfig,
  deps: { env?: NodeJS.ProcessEnv; probe?: () => Promise<DockerProbeStatus> } = {},
): Promise<WorkspaceGate> {
  const env = deps.env ?? process.env;
  let workspace: EffectiveWorkspaceMode;
  try {
    workspace = resolveWorkspaceMode(config, env);
  } catch (err) {
    return { kind: 'invalid', message: (err as Error).message, warning: null };
  }
  const warning = workspaceSandboxWarning(config, workspace.mode, env);
  if (workspace.mode !== 'docker') return { kind: 'worktree', warning: null };
  const dockerErr = dockerWorkspacePreflightError(await (deps.probe ?? probeDocker)());
  if (dockerErr) return { kind: 'preflight-failed', message: dockerErr, warning };
  return {
    kind: 'docker-unavailable',
    message:
      'workspace.mode is docker: the Docker workspace pipeline is not available yet (follow-up to #1759) — not claiming any issue. Set workspace.mode: worktree to run today.',
    warning,
  };
}

/** Workspace mode for status display; an invalid FACTORY_WORKSPACE_MODE must not crash status. */
export function statusWorkspaceMode(config: FactoryConfig): EffectiveWorkspaceMode {
  try {
    return resolveWorkspaceMode(config);
  } catch {
    return { mode: 'worktree', source: 'default' };
  }
}
