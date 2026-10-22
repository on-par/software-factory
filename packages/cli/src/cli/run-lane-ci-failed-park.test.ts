// packages/cli/src/cli/run-lane-ci-failed-park.test.ts — a ci-failed park with a running heartbeat, through runLane and the real GitHub queue (#3427)

import {
  CLAIM_EXPIRES_LABEL_PREFIX,
  createGithubQueue,
  laneLabel,
  PARKED_LABEL,
  QUEUED_LABEL,
  queueOrderLabel,
  type QueueGitHubClient,
  type QueueIssue,
} from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { laneQueueDeps } from './index.js';
import { CiFailedError } from './land-pr.js';
import { runLane } from './run-lane.js';

const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };

async function runCiFailedPark(opts: { failParkedAddOnce: boolean }) {
  const store = new Map<number, Set<string>>([
    [267, new Set([QUEUED_LABEL, laneLabel('mac-v1'), queueOrderLabel(57)])],
  ]);
  let hbArmed = false;
  let hbStarted = false;
  let failParkedAddOnce = opts.failParkedAddOnce;
  let releaseHb!: () => void;
  const hbGate = new Promise<void>((resolve) => {
    releaseHb = resolve;
  });
  let failCi!: () => void;
  const ciGate = new Promise<void>((_resolve, reject) => {
    failCi = () => reject(new CiFailedError('CI failed for PR #353 — refusing to merge', 353));
  });
  ciGate.catch(() => {});

  const client: QueueGitHubClient = {
    async listOpenIssuesWithLabels({ labels }) {
      const result: QueueIssue[] = [];
      for (const [number, set] of store) {
        if (labels.every((l) => set.has(l))) result.push({ number, labels: [...set] });
      }
      return result;
    },
    async getIssueLabels({ issue_number }) {
      return [...(store.get(issue_number) ?? new Set<string>())];
    },
    async addLabels({ issue_number, labels }) {
      await Promise.resolve();
      if (failParkedAddOnce && labels.includes(PARKED_LABEL)) {
        failParkedAddOnce = false;
        throw new Error('github 502');
      }
      const set = store.get(issue_number) ?? new Set<string>();
      for (const label of labels) set.add(label);
      store.set(issue_number, set);
    },
    async removeLabel({ issue_number, name }) {
      store.get(issue_number)?.delete(name);
    },
    async ensureLabel(params) {
      if (hbArmed && params.name.startsWith(CLAIM_EXPIRES_LABEL_PREFIX)) {
        hbArmed = false;
        hbStarted = true;
        await hbGate;
      }
      return false;
    },
  };
  const queue = createGithubQueue({ client, owner: 'on-par', repo: 'ship-it', claimantId: 'mini-1' });
  const events: Array<{ type: string; message: string }> = [];

  vi.useFakeTimers();
  try {
    const runPromise = runLane('mac-v1', [], '/repo', 'on-par/ship-it', paths, {
      ...laneQueueDeps(queue, 'mac-v1'),
      ship: async () => 'factory/267',
      waitMerge: async () => {
        hbArmed = true;
        await ciGate;
      },
      pathExists: () => false,
      emitEvent: (_p, type, _issue, message) => {
        events.push({ type, message: String(message) });
      },
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(hbStarted).toBe(true);
    expect(store.get(267)?.has('factory:in-progress')).toBe(true);

    failCi();
    await vi.advanceTimersByTimeAsync(0);
    releaseHb();
    await runPromise;
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
  } finally {
    vi.useRealTimers();
  }
  return { labels: [...(store.get(267) ?? [])].sort(), events };
}

describe('runLane ci-failed park with the real GitHub queue (#3427)', () => {
  it('ci-failed park with a running heartbeat ends with lane label plus factory:parked', async () => {
    const { labels, events } = await runCiFailedPark({ failParkedAddOnce: false });
    expect(labels).toEqual(['factory:lane:mac-v1', 'factory:parked']);
    expect(labels.some((l) => l.startsWith('factory:claim-expires:'))).toBe(false);
    expect(events.map((e) => e.type)).toContain('parked');
    expect(events.find((e) => e.type === 'parked')?.message).toContain('parked (ci-failed)');
    expect(events.some((e) => e.type === 'fail')).toBe(false);
  });

  it('ci-failed park leaves lane plus factory:parked when the first parked add fails once', async () => {
    const { labels, events } = await runCiFailedPark({ failParkedAddOnce: true });
    expect(labels).toEqual(['factory:lane:mac-v1', 'factory:parked']);
    expect(labels.some((l) => l.startsWith('factory:claim-expires:'))).toBe(false);
    expect(events.map((e) => e.type)).toContain('parked');
  });
});
