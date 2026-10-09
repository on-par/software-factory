import { readFileSync } from 'node:fs';
import type { QueueGitHubClient } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';
import { runUnpark, UnparkError } from './unpark.js';

function fakeClient(labels: Map<number, string[]>) {
  const addLabels = vi.fn(async ({ issue_number, labels: add }: { issue_number: number; labels: string[] }) => {
    const have = labels.get(issue_number) ?? [];
    labels.set(issue_number, [...have, ...add.filter((l) => !have.includes(l))]);
  });
  const removeLabel = vi.fn(async ({ issue_number, name }: { issue_number: number; name: string }) => {
    labels.set(
      issue_number,
      (labels.get(issue_number) ?? []).filter((l) => l !== name),
    );
  });
  const client: QueueGitHubClient = {
    listOpenIssuesWithLabels: async ({ labels: want }) =>
      [...labels.entries()]
        .filter(([, have]) => want.every((w) => have.includes(w)))
        .map(([number, have]) => ({ number, labels: [...have] })),
    getIssueLabels: async ({ issue_number }) => [...(labels.get(issue_number) ?? [])],
    addLabels,
    removeLabel,
    ensureLabel: async () => false,
  };
  return { client, addLabels, removeLabel };
}

const base = { owner: 'o', repo: 'r' };
const peers = (): [number, string[]][] => [
  [1, ['factory:queued', 'factory:lane:ops', 'factory:order:1']],
  [2, ['factory:queued', 'factory:lane:ops', 'factory:order:2']],
];

describe('runUnpark', () => {
  it('re-queues a parked issue at lane max + 1 and removes factory:parked', async () => {
    const labels = new Map([...peers(), [42, ['bug', 'factory:parked', 'factory:lane:ops']] as [number, string[]]]);
    const { client } = fakeClient(labels);
    const res = await runUnpark({ ...base, client, issue: 42 });
    expect(res.order).toBe(3);
    expect(res.lane).toBe('ops');
    expect(res.labelsAfter).toContain('factory:queued');
    expect(res.labelsAfter).toContain('factory:lane:ops');
    expect(res.labelsAfter).not.toContain('factory:parked');
    expect(res.labelsAfter.filter((l) => l.startsWith('factory:order:'))).toEqual(['factory:order:3']);
  });

  it('replaces a stale order label with exactly one fresh one', async () => {
    const labels = new Map([
      ...peers(),
      [42, ['factory:parked', 'factory:lane:ops', 'factory:order:7']] as [number, string[]],
    ]);
    const { client } = fakeClient(labels);
    const res = await runUnpark({ ...base, client, issue: 42 });
    expect(res.labelsAfter.filter((l) => l.startsWith('factory:order:'))).toEqual(['factory:order:3']);
  });

  it('rejects an issue that is not parked without writing', async () => {
    const { client, addLabels, removeLabel } = fakeClient(new Map([[5, ['factory:lane:ops']]]));
    await expect(runUnpark({ ...base, client, issue: 5 })).rejects.toMatchObject({ code: 'not-parked' });
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('requires --lane when there are zero or several lane labels', async () => {
    const zero = fakeClient(new Map([[5, ['factory:parked']]]));
    await expect(runUnpark({ ...base, client: zero.client, issue: 5 })).rejects.toMatchObject({
      code: 'lane-required',
    });
    expect(zero.removeLabel).not.toHaveBeenCalled();
    const two = fakeClient(new Map([[5, ['factory:parked', 'factory:lane:a', 'factory:lane:b']]]));
    const err = await runUnpark({ ...base, client: two.client, issue: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnparkError);
    expect((err as UnparkError).code).toBe('lane-required');
    expect((err as UnparkError).message).toContain('a, b');
    expect(two.addLabels).not.toHaveBeenCalled();
    expect(two.removeLabel).not.toHaveBeenCalled();
  });

  it('--lane overrides and removes other lane labels', async () => {
    const { client } = fakeClient(new Map([[5, ['factory:parked', 'factory:lane:ops']]]));
    const res = await runUnpark({ ...base, client, issue: 5, lane: 'daw' });
    expect(res.lane).toBe('daw');
    expect(res.labelsAfter.filter((l) => l.startsWith('factory:lane:'))).toEqual(['factory:lane:daw']);
  });

  it('keeps factory:parked when enqueue fails so a retry is possible', async () => {
    const labels = new Map([[5, ['factory:parked', 'factory:lane:ops']]]);
    const { client } = fakeClient(labels);
    client.addLabels = async () => {
      throw new Error('api down');
    };
    await expect(runUnpark({ ...base, client, issue: 5 })).rejects.toMatchObject({ code: 'unpark-failed' });
    expect(labels.get(5)).toContain('factory:parked');
  });

  it('wraps a failing initial label read as unpark-failed', async () => {
    const { client } = fakeClient(new Map());
    client.getIssueLabels = async () => {
      throw new Error('read down');
    };
    await expect(runUnpark({ ...base, client, issue: 5 })).rejects.toMatchObject({ code: 'unpark-failed' });
  });

  it('matches the golden fixture', async () => {
    const labels = new Map([...peers(), [42, ['bug', 'factory:parked', 'factory:lane:ops']] as [number, string[]]]);
    const { client } = fakeClient(labels);
    const res = await runUnpark({ ...base, client, issue: 42 });
    const golden = JSON.parse(readFileSync(new URL('./__fixtures__/unpark.json', import.meta.url), 'utf-8'));
    expect(res).toEqual(golden);
  });
});
