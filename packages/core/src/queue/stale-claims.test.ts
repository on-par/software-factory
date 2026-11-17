// packages/core/src/queue/stale-claims.test.ts — Expired-lease claim detection and release (#1500).

import { beforeEach, describe, expect, it } from 'vitest';

import { claimedByLabel, claimExpiresLabel, IN_PROGRESS_LABEL, type QueueIssue } from './github-queue.js';
import { createFakeStore } from '../test-support/fake-queue-store.js';
import { defaultClockSkewCache } from './clock-skew.js';
import type { OrphanClaimLabelSweep } from './claim-label-sweep.js';
import { findStaleClaims, releaseStaleClaims } from './stale-claims.js';

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

describe('findStaleClaims', () => {
  it('returns an issue whose lease has expired', () => {
    const label = claimExpiresLabel(NOW_SECONDS - 60);
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([{ issue: 1, label, expiresAt: NOW_SECONDS - 60 }]);
  });

  it('skips an issue whose lease has not yet expired', () => {
    const label = claimExpiresLabel(NOW_SECONDS + 60);
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([]);
  });

  it('treats an issue at the exact expiry second as stale (the deadline has passed)', () => {
    const label = claimExpiresLabel(NOW_SECONDS);
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, label] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([{ issue: 1, label, expiresAt: NOW_SECONDS }]);
  });

  it('skips an issue carrying factory:in-progress but no lease label', () => {
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([]);
  });

  it('skips an issue carrying one expired and one still-live lease label', () => {
    const expired = claimExpiresLabel(NOW_SECONDS - 60);
    const live = claimExpiresLabel(NOW_SECONDS + 60);
    const issues: QueueIssue[] = [{ number: 1, labels: [IN_PROGRESS_LABEL, expired, live] }];
    const stale = findStaleClaims(issues, { now });
    expect(stale).toEqual([]);
  });
});

describe('releaseStaleClaims', () => {
  it('removes factory:in-progress and the lease label, re-adds factory:queued, leaves lane/order labels', async () => {
    const label = claimExpiresLabel(NOW_SECONDS - 60);
    const { state, client } = createFakeStore(
      [{ number: 1, labels: [IN_PROGRESS_LABEL, label, 'factory:lane:default', 'factory:order:3'] }],
      [],
    );

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([{ issue: 1, label, expiresAt: NOW_SECONDS - 60, released: true, outcome: 'released' }]);
    expect([...state.get(1)!].sort()).toEqual(['factory:lane:default', 'factory:order:3', 'factory:queued'].sort());
  });

  it('returns [] and performs no writes when nothing is stale', async () => {
    const { client, writes } = createFakeStore([{ number: 1, labels: [] }], []);

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('records released: false with the error message when one issue fails, and still releases the other', async () => {
    const label1 = claimExpiresLabel(NOW_SECONDS - 60);
    const label2 = claimExpiresLabel(NOW_SECONDS - 30);
    const { state, client } = createFakeStore(
      [
        { number: 1, labels: [IN_PROGRESS_LABEL, label1] },
        { number: 2, labels: [IN_PROGRESS_LABEL, label2, 'factory:lane:default', 'factory:order:1'] },
      ],
      [],
    );
    const originalRemoveLabel = client.removeLabel.bind(client);
    client.removeLabel = async (input) => {
      if (input.issue_number === 1) throw new Error('boom');
      return originalRemoveLabel(input);
    };

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([
      { issue: 1, label: label1, expiresAt: NOW_SECONDS - 60, released: false, outcome: 'failed', detail: 'boom' },
      { issue: 2, label: label2, expiresAt: NOW_SECONDS - 30, released: true, outcome: 'released' },
    ]);
    expect(state.get(2)!.has('factory:queued')).toBe(true);
  });

  it('leaves a parked issue with an expired lease parked and unqueued (#3193)', async () => {
    const { state, client } = createFakeStore(
      [
        {
          number: 1,
          labels: [
            IN_PROGRESS_LABEL,
            claimExpiresLabel(NOW_SECONDS - 60),
            'factory:parked',
            'factory:lane:self-repair',
          ],
        },
      ],
      [],
    );

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results[0]?.released).toBe(true);
    expect([...(state.get(1) ?? [])].sort()).toEqual(['factory:lane:self-repair', 'factory:parked']);
  });

  it('removes the stale claimant labels, in-progress and the expired lease and reports released', async () => {
    const label = claimExpiresLabel(NOW_SECONDS - 60);
    const { state, client } = createFakeStore(
      [
        {
          number: 42,
          labels: [IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), label, 'factory:lane:default', 'factory:order:1'],
        },
      ],
      [],
    );

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([{ issue: 42, label, expiresAt: NOW_SECONDS - 60, released: true, outcome: 'released' }]);
    expect([...state.get(42)!].sort()).toEqual(['factory:lane:default', 'factory:order:1', 'factory:queued']);
  });

  it('skips and reports renewed when the fresh read shows a heartbeat-renewed lease', async () => {
    const stale = claimExpiresLabel(NOW_SECONDS - 60);
    const renewed = claimExpiresLabel(NOW_SECONDS + 600);
    const { state, client, writes } = createFakeStore(
      [{ number: 42, labels: [IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), renewed] }],
      [],
    );
    client.listOpenIssuesWithLabels = async () => [
      { number: 42, labels: [IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), stale] },
    ];

    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });

    expect(results).toEqual([
      { issue: 42, label: stale, expiresAt: NOW_SECONDS - 60, released: false, outcome: 'renewed' },
    ]);
    expect(writes).toEqual([]);
    expect([...state.get(42)!].sort()).toEqual([IN_PROGRESS_LABEL, claimedByLabel('host-a-1'), renewed].sort());
  });
});

describe('releaseStaleClaims orphan lease-label sweep (#1623)', () => {
  it('releaseStaleClaims sweeps 56 orphaned lease labels and keeps the 4 on open issues (#1623)', async () => {
    const expires = Array.from({ length: 50 }, (_, i) => claimExpiresLabel(NOW_SECONDS + 1000 + i));
    const owners = Array.from({ length: 10 }, (_, i) => claimedByLabel(`host-${i}`));
    const { client, deletedRepoLabels, repoLabelSet } = createFakeStore(
      [
        { number: 1, labels: [IN_PROGRESS_LABEL, expires[0]!, owners[0]!] },
        { number: 2, labels: [IN_PROGRESS_LABEL, expires[1]!, owners[1]!] },
      ],
      [...expires, ...owners],
    );
    const sweeps: OrphanClaimLabelSweep[] = [];
    const onLabelSweep = (sweep: OrphanClaimLabelSweep) => void sweeps.push(sweep);
    await expect(releaseStaleClaims({ client, owner: 'o', repo: 'r', now, onLabelSweep })).resolves.toEqual([]);
    expect(deletedRepoLabels).toHaveLength(56);
    expect([...repoLabelSet].sort()).toEqual([expires[0], expires[1], owners[0], owners[1]].sort());
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ ran: true, remaining: 0 });
    expect(sweeps[0]!.deleted).toHaveLength(56);
  });

  it('releaseStaleClaims deletes leftover lease labels when no issue is claimed (#1623)', async () => {
    const leftovers = [
      claimExpiresLabel(NOW_SECONDS - 500),
      claimExpiresLabel(NOW_SECONDS - 400),
      claimedByLabel('h-9'),
    ];
    const { client, repoLabelSet } = createFakeStore([{ number: 3, labels: ['bug'] }], [...leftovers, 'bug']);
    await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });
    expect([...repoLabelSet]).toEqual(['bug']);
  });

  it('releaseStaleClaims still returns releases when the sweep throws', async () => {
    const stale = claimExpiresLabel(NOW_SECONDS - 60);
    const { client } = createFakeStore([{ number: 1, labels: [IN_PROGRESS_LABEL, claimedByLabel('h-1'), stale] }], []);
    client.listRepoLabels = async () => {
      throw new Error('rate limited');
    };
    const sweepErrors: unknown[] = [];
    const onLabelSweepError = (err: unknown) => void sweepErrors.push(err);
    const out = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now, onLabelSweepError });
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe('released');
    expect(sweepErrors).toEqual([expect.objectContaining({ message: 'rate limited' })]);
  });
});

describe('releaseStaleClaims clock skew guard (#3149)', () => {
  const label = claimExpiresLabel(NOW_SECONDS - 60);
  const claimed = () => createFakeStore([{ number: 1, labels: [IN_PROGRESS_LABEL, label] }], [label]);

  beforeEach(() => defaultClockSkewCache.clear());

  it.each([300_000, -300_000])(
    'releaseStaleClaims refuses to reap when the local clock is %i ms off GitHub',
    async (skew) => {
      const { state, client, writes } = claimed();
      const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now, clockSkewMs: async () => skew });
      expect(results).toEqual([
        {
          issue: 1,
          label,
          expiresAt: NOW_SECONDS - 60,
          released: false,
          outcome: 'refused-clock-skew',
          skewMs: skew,
          detail: `local clock is ${skew}ms off GitHub (max 60000ms)`,
        },
      ]);
      expect([...state.get(1)!].sort()).toEqual([IN_PROGRESS_LABEL, label].sort());
      expect(writes).toEqual([]);
    },
  );

  it('still runs the orphan lease-label sweep after a refusal', async () => {
    const { client } = claimed();
    const sweeps: unknown[] = [];
    const onLabelSweep = (sweep: unknown) => void sweeps.push(sweep);
    await releaseStaleClaims({ client, owner: 'o', repo: 'r', now, clockSkewMs: async () => 300_000, onLabelSweep });
    expect(sweeps).toHaveLength(1);
  });

  it('releaseStaleClaims reaps as before when the clock skew is 2 seconds', async () => {
    const { state, client } = claimed();
    let probes = 0;
    const clockSkewMs = async () => (probes++, 2_000);
    const results = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now, clockSkewMs });
    expect(results).toEqual([{ issue: 1, label, expiresAt: NOW_SECONDS - 60, released: true, outcome: 'released' }]);
    expect(state.get(1)!.has(IN_PROGRESS_LABEL)).toBe(false);
    expect(state.get(1)!.has(label)).toBe(false);
    expect(probes).toBe(1);
  });

  it('honours maxClockSkewMs and treats a skew equal to it as acceptable', async () => {
    const { client } = claimed();
    const [r] = await releaseStaleClaims({
      client,
      owner: 'o',
      repo: 'r',
      now,
      maxClockSkewMs: 5000,
      clockSkewMs: async () => 5000,
    });
    expect(r!.outcome).toBe('released');
  });

  it('reaps when the skew cannot be measured', async () => {
    const { client } = claimed();
    const [r] = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now, clockSkewMs: async () => null });
    expect(r!.outcome).toBe('released');
  });

  it('measures through client.serverDate by default and refuses on a 5 minute skew', async () => {
    const { state, client } = claimed();
    client.serverDate = async () => new Date(NOW_MS - 300_000).toUTCString();
    const [r] = await releaseStaleClaims({ client, owner: 'o', repo: 'r', now });
    expect(r!.outcome).toBe('refused-clock-skew');
    expect(r!.skewMs).toBe(300_000);
    expect(state.get(1)!.has(IN_PROGRESS_LABEL)).toBe(true);
  });

  it('reaps when serverDate reports a small skew or the client has no serverDate', async () => {
    const { client } = claimed();
    client.serverDate = async () => new Date(NOW_MS - 2000).toUTCString();
    expect((await releaseStaleClaims({ client, owner: 'o', repo: 'r', now }))[0]!.outcome).toBe('released');
    defaultClockSkewCache.clear();
    const plain = claimed();
    expect((await releaseStaleClaims({ client: plain.client, owner: 'o', repo: 'r', now }))[0]!.outcome).toBe(
      'released',
    );
  });

  it('never consults the probe when nothing is stale', async () => {
    const { client } = createFakeStore([{ number: 1, labels: [] }], []);
    let probes = 0;
    const clockSkewMs = async () => (probes++, 300_000);
    await releaseStaleClaims({ client, owner: 'o', repo: 'r', now, clockSkewMs });
    expect(probes).toBe(0);
  });
});
