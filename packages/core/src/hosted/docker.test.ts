import { describe, expect, it } from 'vitest';

import type { ExecFn } from '../utils/exec.js';
import { createDockerEngine } from './docker.js';

interface ExecCall {
  cmd: string;
  opts: Parameters<ExecFn>[1];
}

function fakeExec(script: (call: ExecCall) => { stdout: string; stderr: string }) {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, opts) => {
    calls.push({ cmd, opts });
    return script({ cmd, opts });
  };
  return { exec, calls };
}

describe('createDockerEngine.createLaneContainer', () => {
  it('creates (but does not start) a container carrying the factory.managed=true label', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: 'containerid123', stderr: '' }));
    const engine = createDockerEngine({ exec });

    const result = await engine.createLaneContainer('sf-job-run-1-my-lane');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe(
      "docker create --name 'sf-job-run-1-my-lane' --label 'factory.managed=true' 'node:20-alpine'",
    );
    expect(result).toEqual({ containerName: 'sf-job-run-1-my-lane' });
  });

  it('uses the configured laneImage instead of the default', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: 'containerid123', stderr: '' }));
    const engine = createDockerEngine({ exec, laneImage: 'ubuntu:24.04' });

    await engine.createLaneContainer('sf-job-run-2-other-lane');

    expect(calls[0]?.cmd).toContain("'ubuntu:24.04'");
  });
});
