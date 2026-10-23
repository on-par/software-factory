import type { Octokit } from '@octokit/rest';
import { createOctokitQueueClient } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { renderUnparkLines } from './queue-output.js';
import { keepOrderInput, runUnpark } from './unpark.js';

const names = (...n: string[]) => n.map((name) => ({ name }));

/** Octokit mock for lane `ops`: #23 queued at order 23, #24 kept order:24 after `factory:queued` was removed, #12 parked. */
function opsOctokit() {
  const issues = {
    createLabel: vi.fn(async () => ({})),
    addLabels: vi.fn(async () => ({})),
    removeLabel: vi.fn(async () => ({})),
    listForRepo: vi.fn(async () => ({
      data: [
        { number: 23, labels: names('factory:queued', 'factory:lane:ops', 'factory:order:23') },
        { number: 24, labels: names('factory:lane:ops', 'factory:order:24') },
        { number: 12, labels: names('factory:parked', 'factory:lane:ops') },
      ],
    })),
    listLabelsOnIssue: vi.fn(async () => ({ data: names('factory:parked', 'factory:lane:ops') })),
  };
  return { issues, octokit: { rest: { issues } } as never };
}

describe('unpark order-label-kept-after-queued-removed', () => {
  it('assigns the next free position, never the order label an open non-queued issue kept', async () => {
    const { issues, octokit } = opsOctokit();

    const json = await runUnpark({ client: createOctokitQueueClient(octokit), owner: 'o', repo: 'r', issue: 12 });

    expect(json).toMatchObject({ action: 'unpark', issue: 12, lane: 'ops', order: 25 });
    expect(json.collision).toEqual({ order: 24, heldBy: [24] });
    const added = (issues.addLabels.mock.calls as any[]).flatMap(([a]) => a.labels);
    expect(added).toContain('factory:order:25');
    expect(added).not.toContain('factory:order:24');
    expect(renderUnparkLines(json).join('\n')).toContain('factory:order:24 held by #24');
  });
});

describe('keepOrderInput (#3554)', () => {
  it('is empty without --keep-order and wires the park-comment reader with it', async () => {
    const octokit = {} as Octokit;
    expect(keepOrderInput(undefined, octokit, 'o/r', 7)).toEqual({});
    const input = keepOrderInput(true, octokit, 'o/r', 7);
    expect(input.keepOrder).toBe(true);
    expect(typeof input.readParkedOrder).toBe('function');
  });
});
