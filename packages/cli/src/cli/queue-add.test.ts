import { createGithubQueue, createOctokitQueueClient } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { buildQueueAddJson } from './queue-add-json.js';

const names = (...n: string[]) => n.map((name) => ({ name }));

/** Octokit mock for lane `ops`: #23 queued at order 23, #24 kept order:24 after `factory:queued` was removed. */
function opsOctokit() {
  const addedArgs: any[] = [];
  const issues = {
    createLabel: vi.fn(async () => ({})),
    addLabels: async (arg: any) => (addedArgs.push(arg), {}),
    removeLabel: vi.fn(async () => ({})),
    listForRepo: vi.fn(async () => ({
      data: [
        { number: 23, labels: names('factory:queued', 'factory:lane:ops', 'factory:order:23') },
        { number: 24, labels: names('factory:lane:ops', 'factory:order:24') },
      ],
    })),
    listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
  };
  return {
    addedArgs,
    octokit: { paginate: async (fn: any, args: any) => (await fn(args)).data, rest: { issues } } as never,
  };
}

describe('queue add order-label-kept-after-queued-removed', () => {
  it('never assigns the order label an open non-queued issue kept', async () => {
    const { addedArgs, octokit } = opsOctokit();
    const queue = createGithubQueue({ client: createOctokitQueueClient(octokit), owner: 'o', repo: 'r' });

    const json = buildQueueAddJson('ops', await queue.enqueue('ops', [30]));

    expect(json.issues[0]).toMatchObject({ number: 30, outcome: 'queued', order: 25 });
    expect(json.issues[0].collision).toEqual({ order: 24, heldBy: [24] });
    const added = addedArgs.flatMap((a) => a.labels);
    expect(added).toContain('factory:order:25');
    expect(added).not.toContain('factory:order:24');
  });
});
