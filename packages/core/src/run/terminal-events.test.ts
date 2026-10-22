import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderBreaker } from '../router/breaker.js';
import type { ModelRouter } from '../router/index.js';
import type { Workspace } from './ports.js';
import type { RunPorts } from './run-issue.js';
import { withSingleTerminalEvent } from './terminal-events.js';

type Log = ReturnType<RunPorts['events']>;

function wrapped(): { events: RunPorts['events']; log: ReturnType<typeof vi.fn<Log>> } {
  const log = vi.fn<Log>();
  const ports: RunPorts = {
    router: {} as ModelRouter,
    octokit: {} as Octokit,
    workspace: {} as Workspace,
    breaker: {} as ProviderBreaker,
    resolveConstitution: () => null,
    events: () => log,
  };
  return { events: withSingleTerminalEvent(ports).events, log };
}

describe('withSingleTerminalEvent (#3435)', () => {
  it('rewrites a terminal kind from a phase-scoped logger to the phase kind and keeps extras', () => {
    const { events, log } = wrapped();
    events('check')('fail', 'stuck', { failoverReason: 'timeout' });
    expect(log).toHaveBeenCalledWith('check', '[fail] stuck', { failoverReason: 'timeout' });
  });

  it('demotes to warn for an unknown phase', () => {
    const { events, log } = wrapped();
    events('mystery')('escalate', 'help');
    expect(log).toHaveBeenCalledWith('warn', '[escalate] help');
  });

  it('passes a non-terminal kind through unchanged', () => {
    const { events, log } = wrapped();
    events('build')('rework', 'round 1');
    expect(log).toHaveBeenCalledWith('rework', 'round 1');
  });

  it('passes a terminal kind through the unscoped logger', () => {
    const { events, log } = wrapped();
    events()('escalate', 'done');
    expect(log).toHaveBeenCalledWith('escalate', 'done');
  });
});
