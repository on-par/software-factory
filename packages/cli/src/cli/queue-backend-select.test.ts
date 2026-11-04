// packages/cli/src/cli/queue-backend-select.test.ts — queue backend selection from tracker.kind (#3918)
import type { GithubQueueBackendOptions } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { CliExitError } from './errors.js';
import { selectQueueBackend } from './queue-backend-select.js';

const linearTracker = {
  kind: 'linear' as const,
  linear: {
    teamKey: 'ON',
    projects: { Foreman: 'o/r' },
    readyLabel: 'factory:ready',
    laneLabelGroup: 'lane',
    states: { ready: 'Todo', inProgress: 'In Progress', parked: 'Todo' },
  },
};
const githubOptions = (): GithubQueueBackendOptions => ({
  client: {} as GithubQueueBackendOptions['client'],
  owner: 'o',
  repo: 'r',
});

function select(tracker: unknown, env: Record<string, string | undefined>, ghRepo = 'o/r') {
  const github = vi.fn(githubOptions);
  const run = () =>
    selectQueueBackend({
      factoryConfig: tracker === undefined ? {} : { tracker: tracker as never },
      ghRepo,
      env,
      github,
      warn: () => undefined,
    });
  return { github, run };
}

describe('selectQueueBackend', () => {
  it('selects the GitHub backend when the config has no tracker key', () => {
    const { github, run } = select(undefined, {});
    expect(run().kind).toBe('github');
    expect(github).toHaveBeenCalledTimes(1);
  });

  it('selects the GitHub backend when tracker.kind is github', () => {
    const { run } = select({ kind: 'github' }, {});
    expect(run().kind).toBe('github');
  });

  it('selects the Linear backend without building GitHub options', async () => {
    const { github, run } = select(linearTracker, { LINEAR_API_KEY: 'lin_key' });
    const selected = run();
    expect(selected.kind).toBe('linear');
    expect(await selected.backend.pollBlockedParks()).toEqual([]);
    expect(github).not.toHaveBeenCalled();
  });

  it('throws a CliExitError naming LINEAR_API_KEY when the key is missing', () => {
    const { run } = select(linearTracker, { LINEAR_API_KEY: '  ' });
    expect(run).toThrow(CliExitError);
    expect(run).toThrow('LINEAR_API_KEY');
  });

  it('throws naming tracker.linear.projects when the repo is not mapped', () => {
    const { run } = select(linearTracker, { LINEAR_API_KEY: 'k' }, 'x/y');
    expect(run).toThrow(CliExitError);
    expect(run).toThrow('tracker.linear.projects');
  });
});
