import { describe, expect, it } from 'vitest';

import { provisionLaneContainer, type ContainerEngine } from './container.js';

function fakeEngine(): { engine: ContainerEngine; calls: string[] } {
  const calls: string[] = [];
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
  };
  return { engine, calls };
}

describe('provisionLaneContainer (backend: host, the default)', () => {
  it('creates no container for a lane that has not opted into disposable-docker', async () => {
    const { engine, calls } = fakeEngine();

    const result = await provisionLaneContainer(engine, 'host', 'run-1', 'my-lane');

    expect(calls).toEqual([]);
    expect(result).toEqual({ attempted: false, created: false });
  });
});
