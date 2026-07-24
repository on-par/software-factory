import { describe, expect, it, vi } from 'vitest';

import type { PortLease, ReapedLease } from './index.js';
import { defaultFindPortListeners, reapOrphanProcesses } from './orphans.js';

function lease(overrides: Partial<PortLease> = {}): PortLease {
  return {
    worktreeId: '/wt/dead',
    branch: 'dead',
    port: 3500,
    pid: 12345,
    acquiredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function reaped(overrides: Partial<PortLease> = {}): ReapedLease {
  return { lease: lease(overrides), reason: 'dead-pid' };
}

describe('reapOrphanProcesses', () => {
  it('kills and reports a listener whose pgid matches the recorded lease pgids', async () => {
    const killGroup = vi.fn(async (pgid: number) => ({ pgid, terminated: true, forced: false }));
    const findListeners = vi.fn(async () => [{ pid: 1, pgid: 100, command: 'node server.js' }]);
    const events: any[] = [];

    const result = await reapOrphanProcesses({
      reaped: [reaped({ pgids: [100] })],
      findListeners,
      killGroup,
      onEvent: (e) => events.push(e),
    });

    expect(killGroup).toHaveBeenCalledTimes(1);
    expect(killGroup).toHaveBeenCalledWith(100, { graceMs: undefined });
    expect(result).toEqual([
      { action: 'killed', worktreeId: '/wt/dead', port: 3500, pid: 1, pgid: 100, command: 'node server.js' },
    ]);
    expect(events).toEqual(result);
  });

  it('reports without killing when the pgid does not match', async () => {
    const killGroup = vi.fn();
    const findListeners = vi.fn(async () => [{ pid: 1, pgid: 999, command: 'some-other-proc' }]);

    const result = await reapOrphanProcesses({
      reaped: [reaped({ pgids: [100] })],
      findListeners,
      killGroup,
    });

    expect(killGroup).not.toHaveBeenCalled();
    expect(result).toEqual([
      { action: 'reported', worktreeId: '/wt/dead', port: 3500, pid: 1, pgid: 999, command: 'some-other-proc' },
    ]);
  });

  it('reports only for leases without pgids (old-format leases)', async () => {
    const killGroup = vi.fn();
    const findListeners = vi.fn(async () => [{ pid: 1, pgid: 100, command: 'anything' }]);

    const result = await reapOrphanProcesses({
      reaped: [reaped()],
      findListeners,
      killGroup,
    });

    expect(killGroup).not.toHaveBeenCalled();
    expect(result[0].action).toBe('reported');
  });

  it('emits nothing when there are no listeners', async () => {
    const findListeners = vi.fn(async () => []);
    const result = await reapOrphanProcesses({ reaped: [reaped({ pgids: [1] })], findListeners });
    expect(result).toEqual([]);
  });
});

describe('defaultFindPortListeners', () => {
  it('parses lsof + ps output into PortListener rows', async () => {
    const execFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '111\n222\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '111  55  node server.js\n222  66  node other.js\n', stderr: '' });

    const listeners = await defaultFindPortListeners(3000, execFn);

    expect(listeners).toEqual([
      { pid: 111, pgid: 55, command: 'node server.js' },
      { pid: 222, pgid: 66, command: 'node other.js' },
    ]);
    expect(execFn).toHaveBeenNthCalledWith(1, 'lsof -nP -tiTCP:3000 -sTCP:LISTEN', { timeoutMs: 5000 });
  });

  it('resolves to [] when lsof finds no listeners (rejects)', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('exit 1'));
    expect(await defaultFindPortListeners(3000, execFn)).toEqual([]);
  });

  it('resolves to [] when ps fails after lsof succeeds', async () => {
    const execFn = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '111\n', stderr: '' })
      .mockRejectedValueOnce(new Error('ps failed'));
    expect(await defaultFindPortListeners(3000, execFn)).toEqual([]);
  });
});
