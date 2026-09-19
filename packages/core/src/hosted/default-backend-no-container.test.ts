import { describe, expect, it } from 'vitest';

import { provisionLaneContainer, type ContainerEngine } from './container.js';

function fakeEngine(): { engine: ContainerEngine; calls: string[]; workspaceCalls: string[] } {
  const calls: string[] = [];
  const workspaceCalls: string[] = [];
  const engine: ContainerEngine = {
    prepareWorkspace: async () => {
      throw new Error('not used');
    },
    run: async () => {
      throw new Error('not used');
    },
    remove: async () => {
      throw new Error('not used');
    },
    async createLaneContainer(containerName) {
      calls.push(containerName);
      return { containerName };
    },
    async prepareLaneWorkspace(containerName) {
      workspaceCalls.push(containerName);
      return { containerRepoPath: '/workspace/repo', clone: { ok: true, commit: 'deadbeef' } };
    },
  };
  return { engine, calls, workspaceCalls };
}

describe('provisionLaneContainer (backend: host, the default)', () => {
  it('creates no container and clones no workspace for a lane that has not opted into disposable-docker', async () => {
    const { engine, calls, workspaceCalls } = fakeEngine();

    const result = await provisionLaneContainer(engine, 'host', 'run-1', 'my-lane', 'owner/example-app');

    expect(calls).toEqual([]);
    expect(workspaceCalls).toEqual([]);
    expect(result).toEqual({ attempted: false, created: false });
  });
});
