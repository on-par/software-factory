import { describe, expect, it, vi } from 'vitest';

import { createOctokitQueueClient } from './github-queue.js';
import { knownRepoLabels, LABEL_LIST_MAX_PAGES } from './label-cache.js';

const spec = (name: string) => ({ owner: 'o', repo: 'r', name, color: '0e8a16', description: 'desc' });

function octokitWith(existing: string[], createLabel = vi.fn(async () => ({}))) {
  const listLabelsForRepo = vi.fn(async ({ page, per_page }: { page: number; per_page: number }) => ({
    data: existing.slice((page - 1) * per_page, page * per_page).map((name) => ({ name })),
  }));
  return { octokit: { rest: { issues: { listLabelsForRepo, createLabel } } } as any, listLabelsForRepo, createLabel };
}

describe('ensureLabel with the repo label cache', () => {
  it('makes 0 createLabel POSTs for a label that already exists', async () => {
    const { octokit, createLabel } = octokitWith(['factory:queued', 'factory:in-progress']);
    const client = createOctokitQueueClient(octokit);
    await expect(client.ensureLabel(spec('factory:queued'))).resolves.toBe(false);
    await expect(client.ensureLabel(spec('factory:in-progress'))).resolves.toBe(false);
    expect(createLabel).not.toHaveBeenCalled();
  });

  it('makes exactly 1 createLabel POST for a missing label, however often it is ensured', async () => {
    const { octokit, createLabel } = octokitWith(['factory:queued']);
    const client = createOctokitQueueClient(octokit);
    await expect(client.ensureLabel(spec('factory:lane:docs'))).resolves.toBe(true);
    await expect(client.ensureLabel(spec('factory:lane:docs'))).resolves.toBe(false);
    expect(createLabel).toHaveBeenCalledTimes(1);
    expect(createLabel).toHaveBeenCalledWith(spec('factory:lane:docs'));
  });

  it('reads the label list once per client and repo, shared by every queue client on that octokit', async () => {
    const { octokit, listLabelsForRepo } = octokitWith(['a', 'b']);
    await createOctokitQueueClient(octokit).ensureLabel(spec('a'));
    await createOctokitQueueClient(octokit).ensureLabel(spec('b'));
    await createOctokitQueueClient(octokit).ensureLabel({ ...spec('a'), repo: 'other' });
    expect(listLabelsForRepo).toHaveBeenCalledTimes(2);
  });

  it('pages through the label list, up to the page cap', async () => {
    const names = Array.from({ length: 250 }, (_, i) => `label-${i}`);
    const { octokit, listLabelsForRepo, createLabel } = octokitWith(names);
    const client = createOctokitQueueClient(octokit);
    await client.ensureLabel(spec('label-249'));
    expect(listLabelsForRepo).toHaveBeenCalledTimes(3);
    expect(createLabel).not.toHaveBeenCalled();

    const many = octokitWith(Array.from({ length: 100 * (LABEL_LIST_MAX_PAGES + 1) }, (_, i) => `l${i}`));
    expect((await knownRepoLabels(many.octokit, 'o', 'r')).size).toBe(100 * LABEL_LIST_MAX_PAGES);
  });

  it('keeps the 422 already_exists fallback for a label created since the list was read', async () => {
    const createLabel = vi.fn(async () => Promise.reject({ status: 422 }));
    const { octokit } = octokitWith([], createLabel);
    const client = createOctokitQueueClient(octokit);
    await expect(client.ensureLabel(spec('factory:queued'))).resolves.toBe(false);
    await expect(client.ensureLabel(spec('factory:queued'))).resolves.toBe(false);
    expect(createLabel).toHaveBeenCalledTimes(1);
  });

  it('falls back to create-then-422 when the label list cannot be read', async () => {
    const createLabel = vi.fn(async () => ({}));
    const octokit: any = {
      rest: {
        issues: {
          listLabelsForRepo: vi.fn(async () => Promise.reject(new Error('403'))),
          createLabel,
        },
      },
    };
    await expect(createOctokitQueueClient(octokit).ensureLabel(spec('x'))).resolves.toBe(true);
    expect(createLabel).toHaveBeenCalledTimes(1);
  });
});
