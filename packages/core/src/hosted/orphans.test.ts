import { describe, expect, it } from 'vitest';

import type { ExecFn } from '../utils/exec.js';
import { listOrphanContainers, reapOrphanContainers } from './orphans.js';

interface ExecCall {
  cmd: string;
}

function fakeExec(script: (call: ExecCall) => { stdout: string; stderr: string }) {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd) => {
    calls.push({ cmd });
    return script({ cmd });
  };
  return { exec, calls };
}

function rejects(props: { stdout?: string; stderr?: string }): never {
  const err = Object.assign(new Error('command failed'), props);
  throw err;
}

describe('listOrphanContainers', () => {
  it('issues exactly the name-filter and label-filter docker ps -a commands', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '', stderr: '' }));

    await listOrphanContainers(exec);

    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe(
      "docker ps -a --filter 'status=exited' --filter 'status=dead' --filter 'name=sf-job-' --format '{{.ID}}\\t{{.Names}}'",
    );
    expect(calls[1].cmd).toBe(
      "docker ps -a --filter 'status=exited' --filter 'status=dead' --filter 'label=factory.managed=true' --format '{{.ID}}\\t{{.Names}}'",
    );
  });

  it('merges and dedupes name-filter and label-filter results by container ID', async () => {
    const { exec } = fakeExec((call) => {
      if (call.cmd.includes('name=sf-job-')) {
        return { stdout: 'abc123\tsf-job-1\ndef456\tsf-job-2\n', stderr: '' };
      }
      return { stdout: 'abc123\tsf-job-1\nghi789\tsome-other\n', stderr: '' };
    });

    const containers = await listOrphanContainers(exec);

    expect(containers).toHaveLength(3);
    expect(containers).toEqual(
      expect.arrayContaining([
        { id: 'abc123', name: 'sf-job-1' },
        { id: 'def456', name: 'sf-job-2' },
        { id: 'ghi789', name: 'some-other' },
      ]),
    );
  });

  it('returns [] when both calls return empty stdout', async () => {
    const { exec } = fakeExec(() => ({ stdout: '', stderr: '' }));

    expect(await listOrphanContainers(exec)).toEqual([]);
  });
});

describe('reapOrphanContainers', () => {
  it('issues docker rm -f -v per container', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '', stderr: '' }));

    const results = await reapOrphanContainers(
      [
        { id: 'abc123', name: 'sf-job-1' },
        { id: 'def456', name: 'sf-job-2' },
      ],
      exec,
    );

    expect(calls.map((c) => c.cmd)).toEqual(["docker rm -f -v 'sf-job-1'", "docker rm -f -v 'sf-job-2'"]);
    expect(results).toEqual([
      { name: 'sf-job-1', id: 'abc123', removed: true, detail: 'docker rm -f -v sf-job-1 ok' },
      { name: 'sf-job-2', id: 'def456', removed: true, detail: 'docker rm -f -v sf-job-2 ok' },
    ]);
  });

  it('reports removed: false with the error text (never throws) when exec rejects', async () => {
    const exec: ExecFn = async () => rejects({ stderr: 'no such container' });

    const results = await reapOrphanContainers([{ id: 'abc123', name: 'sf-job-1' }], exec);

    expect(results).toEqual([
      {
        name: 'sf-job-1',
        id: 'abc123',
        removed: false,
        detail: 'docker rm -f -v sf-job-1 failed: no such container',
      },
    ]);
  });

  it('returns [] and issues no exec for an empty container list', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '', stderr: '' }));

    expect(await reapOrphanContainers([], exec)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
