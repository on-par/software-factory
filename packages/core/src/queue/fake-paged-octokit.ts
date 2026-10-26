// packages/core/src/queue/fake-paged-octokit.ts — test double: an Octokit whose issue list pages by `page`/`per_page` (#3147).

import type { Octokit } from '@octokit/rest';

type ListParams = { labels?: string; page?: number; per_page?: number };

/** Label-state octokit: `listForRepo` honours labels, page and per_page; `paginate` follows pages until a short one. */
export function fakePagedOctokit(labels: Map<number, string[]>): { octokit: Octokit; listPages: () => number } {
  let pages = 0;
  const listForRepo = async ({ labels: want = '', page = 1, per_page = 30 }: ListParams) => {
    pages += 1;
    const wanted = want === '' ? [] : want.split(',');
    const all = [...labels.entries()]
      .filter(([, have]) => wanted.every((w) => have.includes(w)))
      .map(([number, have]) => ({ number, labels: [...have] }));
    return { data: all.slice((page - 1) * per_page, page * per_page) };
  };
  const octokit = {
    paginate: async (fn: (p: ListParams) => Promise<{ data: unknown[] }>, params: ListParams) => {
      const out: unknown[] = [];
      for (let page = 1; ; page++) {
        const { data } = await fn({ ...params, page });
        out.push(...data);
        if (data.length < (params.per_page ?? 30)) return out;
      }
    },
    rest: {
      issues: {
        listForRepo,
        listLabelsForRepo: async () => ({ data: [] }),
        createLabel: async () => ({}),
        listLabelsOnIssue: async ({ issue_number }: { issue_number: number }) => ({
          data: (labels.get(issue_number) ?? []).map((name) => ({ name })),
        }),
        addLabels: async ({ issue_number, labels: add }: { issue_number: number; labels: string[] }) => {
          const have = labels.get(issue_number) ?? [];
          labels.set(issue_number, [...have, ...add.filter((l) => !have.includes(l))]);
        },
        removeLabel: async ({ issue_number, name }: { issue_number: number; name: string }) => {
          labels.set(
            issue_number,
            (labels.get(issue_number) ?? []).filter((l) => l !== name),
          );
        },
      },
    },
  };
  return { octokit: octokit as never, listPages: () => pages };
}
