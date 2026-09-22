import { describe, expect, it } from 'vitest';

import {
  laneContainerName,
  provisionLaneContainer,
  type ContainerEngine,
  type LaneContainerCreateResult,
  type LaneWorkspacePrepared,
} from './container.js';

function fakeEngine(script: { fail?: string; workspaceFail?: string } = {}): {
  engine: ContainerEngine;
  calls: string[];
  workspaceCalls: { containerName: string; repoSlug: string }[];
} {
  const calls: string[] = [];
  const workspaceCalls: { containerName: string; repoSlug: string }[] = [];
  const engine: ContainerEngine = {
    async createLaneContainer(containerName): Promise<LaneContainerCreateResult> {
      calls.push(containerName);
      if (script.fail) throw new Error(script.fail);
      return { containerName };
    },
    async prepareLaneWorkspace(containerName, repoSlug): Promise<LaneWorkspacePrepared> {
      workspaceCalls.push({ containerName, repoSlug });
      if (script.workspaceFail) {
        return { containerRepoPath: '/workspace/repo', clone: { ok: false, error: script.workspaceFail } };
      }
      return { containerRepoPath: '/workspace/repo', clone: { ok: true, commit: 'deadbeef' } };
    },
  };
  return { engine, calls, workspaceCalls };
}

describe('laneContainerName', () => {
  it('builds sf-job-<runId>-<laneSlug>', () => {
    expect(laneContainerName('run-1', 'my-lane')).toBe('sf-job-run-1-my-lane');
  });
});

describe('provisionLaneContainer (backend: disposable-docker)', () => {
  it('creates exactly one container named sf-job-<runId>-<laneSlug> and clones the repo into it', async () => {
    const { engine, calls, workspaceCalls } = fakeEngine();

    const result = await provisionLaneContainer(engine, 'disposable-docker', 'run-1', 'my-lane', 'owner/example-app');

    expect(calls).toEqual(['sf-job-run-1-my-lane']);
    expect(workspaceCalls).toEqual([{ containerName: 'sf-job-run-1-my-lane', repoSlug: 'owner/example-app' }]);
    expect(result).toEqual({
      attempted: true,
      created: true,
      containerName: 'sf-job-run-1-my-lane',
      workspaceCloned: true,
      workspaceError: undefined,
    });
  });

  it('reports the failure reason without throwing when creation fails, and never attempts the clone', async () => {
    const { engine, calls, workspaceCalls } = fakeEngine({ fail: 'docker not found' });

    const result = await provisionLaneContainer(engine, 'disposable-docker', 'run-1', 'my-lane', 'owner/example-app');

    expect(calls).toEqual(['sf-job-run-1-my-lane']);
    expect(workspaceCalls).toEqual([]);
    expect(result).toEqual({
      attempted: true,
      created: false,
      containerName: 'sf-job-run-1-my-lane',
      error: 'docker not found',
    });
  });

  it('reports the clone failure reason without throwing when the workspace clone fails', async () => {
    const { engine, workspaceCalls } = fakeEngine({ workspaceFail: 'fatal: repository not found' });

    const result = await provisionLaneContainer(engine, 'disposable-docker', 'run-1', 'my-lane', 'owner/example-app');

    expect(workspaceCalls).toEqual([{ containerName: 'sf-job-run-1-my-lane', repoSlug: 'owner/example-app' }]);
    expect(result).toEqual({
      attempted: true,
      created: true,
      containerName: 'sf-job-run-1-my-lane',
      workspaceCloned: false,
      workspaceError: 'fatal: repository not found',
    });
  });
});
