// run-queue.test.ts — createRunQueue wires factory draft adoption into the GitHub queue preflight (#4039)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunQueue } from './run-queue.js';

const tmp = createTempDirs();

afterEach(async () => {
  await tmp.cleanup();
});

describe('createRunQueue draft adoption wiring (#4039)', () => {
  it('hands the preflight ops a draftAdoption whose CI probe reads the head SHA checks', async () => {
    const dir = tmp.makeSync('run-queue-');
    mkdirSync(join(dir, 'state'));
    const octokit: any = {
      rest: {
        issues: {
          listForRepo: async () => ({
            data: [
              {
                number: 7,
                title: 'x',
                labels: [{ name: 'factory:queued' }, { name: 'factory:lane:app' }, { name: 'factory:order:1' }],
              },
            ],
          }),
          listLabelsForRepo: async () => ({ data: [] }),
          createLabel: async () => ({}),
        },
        checks: {
          listForRef: vi.fn(async () => ({ data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } })),
        },
      },
      paginate: async () => [
        {
          number: 7,
          title: 'x',
          labels: [{ name: 'factory:queued' }, { name: 'factory:lane:app' }, { name: 'factory:order:1' }],
        },
      ],
    };
    let probed: string | undefined;
    const rt: any = {
      getOctokit: () => octokit,
      createQueuePreflightOps: (_o: unknown, _ow: string, _r: string, opts: any) => opts,
      preflightQueuedIssue: async (_issue: unknown, opts: any) => {
        probed = await opts.draftAdoption.probeCi('abc123');
        return { kind: 'defer' };
      },
    };
    const { queue } = createRunQueue({
      rt,
      paths: {
        state: join(dir, 'state'),
        iterate: join(dir, 'iterate.json'),
        laneFiles: dir,
        events: join(dir, 'e'),
      } as any,
      ghRepo: 'o/r',
      factoryConfig: { merge: {} } as any,
      autoMerge: undefined,
      deferrals: { onDeferred: () => {} } as any,
    });
    await queue().claimNext('app');
    expect(probed).toBe('success');
    expect(octokit.rest.checks.listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'abc123' }));
  });
});
