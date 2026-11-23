import type { Octokit } from '@octokit/rest';

import type { SimRecordedCall } from '../fakes/octokit.js';
import { fakeOctokit } from './index.js';

export interface StoredComment {
  id: number;
  body: string;
  user: { id: number };
}

export function commentStoreOctokit(extra: Record<string, unknown> = {}): {
  store: StoredComment[];
  octokit: Octokit;
  calls: SimRecordedCall[];
} {
  const store: StoredComment[] = [];
  const fake = fakeOctokit({
    'users.getAuthenticated': async () => ({ data: { id: 1 } }),
    'issues.listLabelsOnIssue': async () => ({ data: [] }),
    'issues.listComments': async () => ({ data: store }),
    'issues.createComment': async ({ body }: { body: string }) => {
      const c = { id: store.length + 1, body, user: { id: 1 } };
      store.push(c);
      return { data: c };
    },
    'issues.updateComment': async ({ comment_id, body }: { comment_id: number; body: string }) => {
      const c = store.find((x) => x.id === comment_id);
      if (c) c.body = body;
      return { data: c };
    },
    ...extra,
  });
  return { store, octokit: fake.octokit as Octokit, calls: fake.calls };
}
