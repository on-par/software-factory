// src/hosted/container.ts — Disposable-docker lane workspaces (#1535, #1536).
// All Docker and workspace-fs effects sit behind the injected ContainerEngine
// port so provisioning is hermetic and testable with a fake engine; the real
// docker-CLI adapter lives in docker.ts. (The hosted-exec job runner that
// originally shared this port was removed in 2026-09 — see ADR-0023.)

export interface CloneOutcome {
  /** True when the fresh clone succeeded. */
  ok: boolean;
  /** Resolved HEAD commit SHA when ok — recorded workspace identity. */
  commit?: string;
  /** Failure reason (git stderr / message) when !ok. */
  error?: string;
}

export interface LaneContainerCreateResult {
  containerName: string;
}

export interface LaneWorkspacePrepared {
  /** Path inside the container where the fresh repo clone lands, e.g. /workspace/repo. */
  containerRepoPath: string;
  /** Result of cloning repoSlug fresh from the remote. */
  clone: CloneOutcome;
}

export interface ContainerEngine {
  /** Creates (but does not start) a labeled, disposable container for a ship-it lane
   *  (#1535) — recognition + creation only; no workspace mount, no exec routing, no
   *  teardown. Those belong to later stories. */
  createLaneContainer(containerName: string): Promise<LaneContainerCreateResult>;
  /** Clones repoSlug fresh from the remote into a disposable host temp dir, then
   *  copies it into the already-created lane container — the container's code never
   *  comes from (or touches) the host worktree (#1536). */
  prepareLaneWorkspace(containerName: string, repoSlug: string): Promise<LaneWorkspacePrepared>;
}

/** Backend a ship-it lane's workspace runs on. `'host'` (default) is the existing
 *  sibling-worktree behavior; `'disposable-docker'` opts into a managed, labeled
 *  container per lane (#1535). */
export type WorkspaceBackend = 'host' | 'disposable-docker';

/** Builds the per-lane container name the issue mandates: `sf-job-<runId>-<laneSlug>`. */
export function laneContainerName(runId: string, laneSlug: string): string {
  return `sf-job-${runId}-${laneSlug}`;
}

export interface LaneContainerProvisionResult {
  /** False when the backend isn't 'disposable-docker' — no container was attempted. */
  attempted: boolean;
  created: boolean;
  containerName?: string;
  error?: string;
  /** Set once the container was created and a workspace clone was attempted. */
  workspaceCloned?: boolean;
  workspaceError?: string;
}

/** Recognizes `workspace.backend: disposable-docker` at lane start, creates the
 *  managed container through the existing ContainerEngine port, then clones
 *  repoSlug fresh from the remote into it. A no-op for every other backend
 *  value, so lanes that don't opt in are unaffected (#1535, #1536). */
export async function provisionLaneContainer(
  engine: ContainerEngine,
  backend: WorkspaceBackend,
  runId: string,
  laneSlug: string,
  repoSlug: string,
): Promise<LaneContainerProvisionResult> {
  if (backend !== 'disposable-docker') {
    return { attempted: false, created: false };
  }
  const containerName = laneContainerName(runId, laneSlug);
  try {
    await engine.createLaneContainer(containerName);
  } catch (err) {
    return {
      attempted: true,
      created: false,
      containerName,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const workspace = await engine.prepareLaneWorkspace(containerName, repoSlug);
    return {
      attempted: true,
      created: true,
      containerName,
      workspaceCloned: workspace.clone.ok,
      workspaceError: workspace.clone.ok ? undefined : workspace.clone.error,
    };
  } catch (err) {
    return {
      attempted: true,
      created: true,
      containerName,
      workspaceCloned: false,
      workspaceError: err instanceof Error ? err.message : String(err),
    };
  }
}
