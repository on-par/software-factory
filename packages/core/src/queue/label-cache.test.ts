import { describe, expect, it } from 'vitest';

import { createOctokitQueueClient } from './github-queue.js';
import { knownRepoLabels, LABEL_LIST_MAX_PAGES } from './label-cache.js';

const spec = (name: string) => ({ owner: 'o', repo: 'r', name, color: '0e8a16', description: 'desc' });

function octokitWith(existing: string[], createImpl: (input: unknown) => Promise<unknown> = async () => ({})) {
  const pages: Array<{ repo: string; page: number }> = [];
  const created: unknown[] = [];
  const listLabelsForRepo = async ({ repo, page, per_page }: { repo: string; page: number; per_page: number }) => (
    pages.push({ repo, page }),
    { data: existing.slice((page - 1) * per_page, page * per_page).map((name) => ({ name })) }
  );
  const createLabel = async (input: unknown) => (created.push(input), createImpl(input));
  return { octokit: { rest: { issues: { listLabelsForRepo, createLabel } } } as any, pages, created };
}

describe('ensureLabel with the repo label cache', () => {
  it('makes 0 createLabel POSTs for a label that already exists', async () => {
    const { octokit, created } = octokitWith(['factory:queued', 'factory:in-progress']);
    const client = createOctokitQueueClient(octokit);
    await expect(client.ensureLabel(spec('factory:queued'))).resolves.toBe(false);
    await expect(client.ensureLabel(spec('factory:in-progress'))).resolves.toBe(false);
    expect(created).toEqual([]);
  });

  it('makes exactly 1 createLabel POST for a missing label, however often it is ensured', async () => {
    const { octokit, created } = octokitWith(['factory:queued']);
    const client = createOctokitQueueClient(octokit);
    await expect(client.ensureLabel(spec('factory:lane:docs'))).resolves.toBe(true);
    await expect(client.ensureLabel(spec('factory:lane:docs'))).resolves.toBe(false);
    expect(created).toEqual([spec('factory:lane:docs')]);
  });

  it('reads the label list once per client and repo, shared by every queue client on that octokit', async () => {
    const { octokit, pages } = octokitWith(['a', 'b']);
    await createOctokitQueueClient(octokit).ensureLabel(spec('a'));
    await createOctokitQueueClient(octokit).ensureLabel(spec('b'));
    await createOctokitQueueClient(octokit).ensureLabel({ ...spec('a'), repo: 'other' });
    expect(pages).toEqual([
      { repo: 'r', page: 1 },
      { repo: 'other', page: 1 },
    ]);
  });

  it('pages through the label list, up to the page cap', async () => {
    const names = Array.from({ length: 250 }, (_, i) => `label-${i}`);
    const { octokit, pages, created } = octokitWith(names);
    const client = createOctokitQueueClient(octokit);
    await client.ensureLabel(spec('label-249'));
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(created).toEqual([]);

    const many = octokitWith(Array.from({ length: 100 * (LABEL_LIST_MAX_PAGES + 1) }, (_, i) => `l${i}`));
    expect((await knownRepoLabels(many.octokit, 'o', 'r')).size).toBe(100 * LABEL_LIST_MAX_PAGES);
  });

  it('keeps the 422 already_exists fallback for a label created since the list was read', async () => {
    const { octokit, created } = octokitWith([], async () => Promise.reject({ status: 422 }));
    const client = createOctokitQueueClient(octokit);
    await expect(client.ensureLabel(spec('factory:queued'))).resolves.toBe(false);
    await expect(client.ensureLabel(spec('factory:queued'))).resolves.toBe(false);
    expect(created).toEqual([spec('factory:queued')]);
  });

  it('falls back to create-then-422 when the label list cannot be read', async () => {
    const { octokit, created } = octokitWith([]);
    octokit.rest.issues.listLabelsForRepo = async () => Promise.reject(new Error('403'));
    await expect(createOctokitQueueClient(octokit).ensureLabel(spec('x'))).resolves.toBe(true);
    expect(created).toEqual([spec('x')]);
  });
});
