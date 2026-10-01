import { describe, expect, it, vi } from 'vitest';

import { dockerWorkspacePreflightError, probeDocker } from './workspace-preflight.js';

describe('dockerWorkspacePreflightError', () => {
  it('reports a missing CLI', () => {
    const err = dockerWorkspacePreflightError({ cli: false, daemon: false });
    expect(err).toContain('Docker CLI');
    expect(err).toContain('worktree');
  });
  it('reports an unreachable daemon', () => {
    expect(dockerWorkspacePreflightError({ cli: true, daemon: false })).toContain('Docker daemon is unreachable');
  });
  it('passes when healthy', () => {
    expect(dockerWorkspacePreflightError({ cli: true, daemon: true })).toBeNull();
  });
});

describe('probeDocker', () => {
  it('skips the engine when the CLI is missing', async () => {
    const isAvailable = vi.fn(async () => true);
    expect(await probeDocker({ cliPresent: async () => false, engine: { isAvailable } })).toEqual({
      cli: false,
      daemon: false,
    });
    expect(isAvailable).not.toHaveBeenCalled();
  });
  it('maps engine availability to daemon', async () => {
    const cliPresent = async () => true;
    expect(await probeDocker({ cliPresent, engine: { isAvailable: async () => true } })).toEqual({
      cli: true,
      daemon: true,
    });
    expect(await probeDocker({ cliPresent, engine: { isAvailable: async () => false } })).toEqual({
      cli: true,
      daemon: false,
    });
    expect(
      await probeDocker({
        cliPresent,
        engine: {
          isAvailable: async () => {
            throw new Error('boom');
          },
        },
      }),
    ).toEqual({ cli: true, daemon: false });
  });
  it('treats an engine without isAvailable as unavailable', async () => {
    expect(await probeDocker({ cliPresent: async () => true, engine: {} })).toEqual({ cli: true, daemon: false });
  });
});
