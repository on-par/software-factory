import { describe, expect, it } from 'vitest';

import {
  laneContainerName,
  provisionLaneContainer,
  type ContainerEngine,
  type LaneContainerCreateResult,
} from './container.js';

function fakeEngine(script: { fail?: string } = {}): { engine: ContainerEngine; calls: string[] } {
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
    async createLaneContainer(containerName): Promise<LaneContainerCreateResult> {
      calls.push(containerName);
      if (script.fail) throw new Error(script.fail);
      return { containerName };
    },
  };
  return { engine, calls };
}

describe('laneContainerName', () => {
  it('builds sf-job-<runId>-<laneSlug>', () => {
    expect(laneContainerName('run-1', 'my-lane')).toBe('sf-job-run-1-my-lane');
  });
});

describe('provisionLaneContainer (backend: disposable-docker)', () => {
  it('creates exactly one container named sf-job-<runId>-<laneSlug>', async () => {
    const { engine, calls } = fakeEngine();

    const result = await provisionLaneContainer(engine, 'disposable-docker', 'run-1', 'my-lane');

    expect(calls).toEqual(['sf-job-run-1-my-lane']);
    expect(result).toEqual({ attempted: true, created: true, containerName: 'sf-job-run-1-my-lane' });
  });

  it('reports the failure reason without throwing when creation fails', async () => {
    const { engine, calls } = fakeEngine({ fail: 'docker not found' });

    const result = await provisionLaneContainer(engine, 'disposable-docker', 'run-1', 'my-lane');

    expect(calls).toEqual(['sf-job-run-1-my-lane']);
    expect(result).toEqual({
      attempted: true,
      created: false,
      containerName: 'sf-job-run-1-my-lane',
      error: 'docker not found',
    });
  });
});
