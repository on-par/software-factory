// packages/cli/src/cli/run-queue-backend.test.ts — the memoized GitHub queue backend factory for factory run (#3920).

import { Octokit } from '@octokit/rest';
import { loadFactoryConfig } from '@on-par/factory-core';
import { getFactoryPaths } from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';

import { createDeferralTracker } from './queue-startup.js';

import { createRunQueueBackend } from './run-queue-backend.js';
import type { RunQueueBackendInput } from './run-queue-backend.js';

function input(getOctokit: () => Octokit): RunQueueBackendInput {
  return {
    ghRepo: 'o/r',
    paths: getFactoryPaths('/tmp/run-queue-backend-test'),
    factoryConfig: loadFactoryConfig(),
    getOctokit,
    preflightQueuedIssue: vi.fn(),
    createQueuePreflightOps: vi.fn(),
    autoMerge: undefined,
    deferrals: createDeferralTracker('/tmp/run-queue-backend-test/events.jsonl'),
  };
}

describe('createRunQueueBackend (#3920)', () => {
  it('builds no octokit until first called and returns one memoized backend', () => {
    const getOctokit = vi.fn(() => new Octokit());
    const queue = createRunQueueBackend(input(getOctokit));
    expect(getOctokit).not.toHaveBeenCalled();
    const first = queue();
    expect(queue()).toBe(first);
    expect(getOctokit).toHaveBeenCalledTimes(1);
  });
});
