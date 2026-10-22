import { describe, expect, it, vi } from 'vitest';

import { createOctokitQueueClient } from './github-queue.js';

const comment = (id: number) => ({ id, body: `body-${id}`, created_at: `2026-01-01T00:00:0${id % 10}Z` });
const input = { owner: 'o', repo: 'r', issue_number: 7 };

describe('the Octokit queue client issue comments', () => {
  it('the Octokit queue client posts, lists in id order and deletes issue comments', async () => {
    const createComment = vi.fn(async () => ({ data: { id: 303 } }));
    const deleteComment = vi.fn(async () => ({}));
    const pages = [[comment(205), comment(101)], [comment(303)]];
    const listComments = vi.fn(async ({ page }: { page: number }) => ({ data: pages[page - 1] }));
    const paginate = vi.fn(async (fn: unknown, params: Record<string, unknown>) => {
      expect(fn).toBe(listComments);
      const first = await listComments({ ...params, page: 1 } as { page: number });
      const second = await listComments({ ...params, page: 2 } as { page: number });
      return [...first.data, ...second.data];
    });
    const octokit = { rest: { issues: { createComment, listComments, deleteComment } }, paginate } as any;
    const client = createOctokitQueueClient(octokit);

    await expect(client.createIssueComment({ ...input, body: 'claim-marker' })).resolves.toEqual({ id: 303 });
    expect(createComment).toHaveBeenCalledWith({ ...input, body: 'claim-marker' });

    await expect(client.listIssueComments(input)).resolves.toEqual(
      [101, 205, 303].map((id) => ({ id, body: `body-${id}`, createdAt: comment(id).created_at })),
    );
    expect(paginate.mock.calls[0]?.[1]).toMatchObject({ issue_number: 7, per_page: 100 });

    await expect(client.deleteIssueComment({ owner: 'o', repo: 'r', comment_id: 101 })).resolves.toBeUndefined();
    expect(deleteComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 101 });
  });

  it('deleteIssueComment treats a 404 as already deleted and rethrows any other error', async () => {
    const deleteComment = vi.fn();
    const client = createOctokitQueueClient({ rest: { issues: { deleteComment } } } as any);
    const args = { owner: 'o', repo: 'r', comment_id: 1 };

    deleteComment.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    await expect(client.deleteIssueComment(args)).resolves.toBeUndefined();

    const serverError = Object.assign(new Error('boom'), { status: 500 });
    deleteComment.mockRejectedValueOnce(serverError);
    await expect(client.deleteIssueComment(args)).rejects.toBe(serverError);

    const plain = new Error('no status');
    deleteComment.mockRejectedValueOnce(plain);
    await expect(client.deleteIssueComment(args)).rejects.toBe(plain);
  });
});
