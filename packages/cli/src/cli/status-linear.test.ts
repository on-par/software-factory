// packages/cli/src/cli/status-linear.test.ts — factory status lists the Linear queue when tracker.kind is linear (#3918)

import { describe, expect, it, vi } from 'vitest';

import { h, installShipHarness, logged, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli status (Linear)', () => {
  it('status lists the Linear queue when tracker.kind is linear', async () => {
    vi.stubEnv('LINEAR_API_KEY', 'lin_test_key');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: 'id-12',
                    identifier: 'ON-12',
                    priority: 2,
                    createdAt: '2026-01-01T00:00:00Z',
                    state: { type: 'unstarted' },
                    labels: {
                      nodes: [
                        { id: 'a', name: 'factory:ready', parent: null },
                        { id: 'b', name: 'infra', parent: { name: 'lane' } },
                      ],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200 },
        ),
    );
    h.factoryConfig = {
      ...h.factoryConfig,
      tracker: {
        kind: 'linear',
        linear: {
          teamKey: 'ON',
          projects: { Foreman: h.ghRepo },
          readyLabel: 'factory:ready',
          laneLabelGroup: 'lane',
          states: { ready: 'Todo', inProgress: 'In Progress', parked: 'Todo' },
        },
      },
    } as typeof h.factoryConfig;
    try {
      await runMain('status');
      const out = logged();
      expect(out).toContain('== Queue (Linear) ==');
      expect(out).toContain('  infra ON-12');
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
