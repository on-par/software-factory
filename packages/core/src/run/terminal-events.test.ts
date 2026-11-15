import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import type { ProviderBreaker } from '../router/breaker.js';
import type { ModelRouter } from '../router/index.js';
import type { Workspace } from './ports.js';
import type { RunPorts } from './run-issue.js';
import { withSingleTerminalEvent } from './terminal-events.js';

type Log = ReturnType<RunPorts['events']>;

function wrapped(): { events: RunPorts['events']; entries: unknown[][] } {
  const entries: unknown[][] = [];
  const log = ((...args: unknown[]) => void entries.push(args)) as Log;
  const ports: RunPorts = {
    router: {} as ModelRouter,
    octokit: {} as Octokit,
    workspace: {} as Workspace,
    breaker: {} as ProviderBreaker,
    resolveConstitution: () => null,
    events: () => log,
  };
  return { events: withSingleTerminalEvent(ports).events, entries };
}

describe('withSingleTerminalEvent (#3435)', () => {
  it('rewrites a terminal kind from a phase-scoped logger to the phase kind and keeps extras', () => {
    const { events, entries } = wrapped();
    events('check')('fail', 'stuck', { failoverReason: 'timeout' });
    expect(entries).toEqual([['check', '[fail] stuck', { failoverReason: 'timeout' }]]);
  });

  it('demotes to warn for an unknown phase', () => {
    const { events, entries } = wrapped();
    events('mystery')('escalate', 'help');
    expect(entries).toEqual([['warn', '[escalate] help']]);
  });

  it('passes a non-terminal kind through unchanged', () => {
    const { events, entries } = wrapped();
    events('build')('rework', 'round 1');
    expect(entries).toEqual([['rework', 'round 1']]);
  });

  it('passes a terminal kind through the unscoped logger', () => {
    const { events, entries } = wrapped();
    events()('escalate', 'done');
    expect(entries).toEqual([['escalate', 'done']]);
  });
});
