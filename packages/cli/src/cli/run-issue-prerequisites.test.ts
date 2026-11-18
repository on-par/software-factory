import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';
import { fakeOctokit } from '@on-par/factory-core/testing';

import type { LifecycleResult } from './run-result.js';
import { findOpenPrerequisites, parkOnOpenPrerequisites } from './run-issue-prerequisites.js';

const body = 'Depends on: #3, #1\nPrerequisite: #2\n\nSome text #9';

describe('findOpenPrerequisites', () => {
  it('returns only the open prerequisites, in declaration order', async () => {
    const open = new Set([1, 2]);
    expect(
      await findOpenPrerequisites(
        body,
        async (n) => open.has(n),
        () => {},
      ),
    ).toEqual([1, 2]);
  });

  it('returns [] when the brief declares none', async () => {
    expect(
      await findOpenPrerequisites(
        'no deps here',
        async () => true,
        () => {},
      ),
    ).toEqual([]);
  });

  it('warns on a failed lookup and treats that prerequisite as not open', async () => {
    const warnings: string[] = [];
    const open = await findOpenPrerequisites(
      body,
      async (n) => {
        if (n === 3) throw new Error('rate limited');
        return true;
      },
      (m) => warnings.push(m),
    );
    expect(open).toEqual([1, 2]);
    expect(warnings).toEqual(['prerequisite #3 lookup failed: rate limited']);
  });
});

function harness(openIssues: number[]) {
  const { octokit } = fakeOctokit({
    graphql: async (_query: string, vars: { number: number }) => ({
      repository: {
        issue: openIssues.includes(vars.number)
          ? { state: 'OPEN', stateReason: null }
          : {
              state: 'CLOSED',
              stateReason: 'COMPLETED',
              closedByPullRequestsReferences: { nodes: [{ merged: true }], pageInfo: { hasNextPage: false } },
            },
      },
    }),
  });
  const recorded: { prerequisites?: number[]; lifecycle?: LifecycleResult; logs: string[] } = { logs: [] };
  const input = {
    brief: body,
    repo: 'acme/widgets',
    octokit: () => octokit as Octokit,
    report: {
      recordPrerequisites: (issues: number[]) => {
        recorded.prerequisites = issues;
      },
      recordLifecycle: (r: LifecycleResult) => {
        recorded.lifecycle = r;
      },
    },
    log: (type: string, msg: string) => recorded.logs.push(`${type}: ${msg}`),
  };
  return { input, recorded };
}

describe('parkOnOpenPrerequisites', () => {
  it('parks and records the open prerequisites', async () => {
    const { input, recorded } = harness([3, 2]);
    expect(await parkOnOpenPrerequisites(input)).toBe(true);
    expect(recorded.prerequisites).toEqual([3, 2]);
    expect(recorded.lifecycle).toEqual({ outcome: 'parked', detail: 'waiting for prerequisites: #3, #2' });
    expect(recorded.logs).toEqual(['issue_deferred: waiting for prerequisites: #3, #2']);
  });

  it('logs a failed lookup as a warn and does not park on it', async () => {
    const { input, recorded } = harness([]);
    const failing = { ...input, octokit: () => fakeOctokit({ graphql: async () => ({}) }).octokit as Octokit };
    expect(await parkOnOpenPrerequisites(failing)).toBe(false);
    expect(recorded.logs).toEqual([
      'warn: prerequisite #3 lookup failed: prerequisite #3 response was incomplete',
      'warn: prerequisite #1 lookup failed: prerequisite #1 response was incomplete',
      'warn: prerequisite #2 lookup failed: prerequisite #2 response was incomplete',
    ]);
  });

  it('does not park when every prerequisite is closed', async () => {
    const { input, recorded } = harness([]);
    expect(await parkOnOpenPrerequisites(input)).toBe(false);
    expect(recorded).toEqual({ logs: [] });
  });
});
