// src/queue/label-cache.ts — Repo labels known to exist, so ensureLabel stops POSTing createLabel
// for labels that are already there (every POST used to fail with a 422 already_exists).

/** Pages of `issues.listLabelsForRepo` read per repo (100 labels each). Labels past the cap fall back to create-then-422. */
export const LABEL_LIST_MAX_PAGES = 10;

export interface LabelListClient {
  rest: {
    issues: {
      listLabelsForRepo?(params: {
        owner: string;
        repo: string;
        per_page: number;
        page: number;
      }): Promise<{ data: Array<{ name: string }> }>;
    };
  };
}

/** Per client instance, per `owner/repo`: label names known to exist. The list is read once per client. */
const knownByClient = new WeakMap<LabelListClient, Map<string, Promise<Set<string>>>>();

async function loadRepoLabels(client: LabelListClient, owner: string, repo: string): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    for (let page = 1; page <= LABEL_LIST_MAX_PAGES; page++) {
      const { data } = await client.rest.issues.listLabelsForRepo!({ owner, repo, per_page: 100, page });
      for (const label of data) names.add(label.name);
      if (data.length < 100) break;
    }
  } catch {
    // Unknown labels just fall back to create-then-422, as before this cache existed.
  }
  return names;
}

/** The mutable set of label names known to exist in `owner/repo`; callers add names they create or see 422 for. */
export function knownRepoLabels(client: LabelListClient, owner: string, repo: string): Promise<Set<string>> {
  let byRepo = knownByClient.get(client);
  if (!byRepo) {
    byRepo = new Map();
    knownByClient.set(client, byRepo);
  }
  const key = `${owner}/${repo}`;
  let labels = byRepo.get(key);
  if (!labels) {
    labels = loadRepoLabels(client, owner, repo);
    byRepo.set(key, labels);
  }
  return labels;
}

/** Drops `name` from the known-labels set so a later ensureLabel recreates it (#1623). */
export async function forgetRepoLabel(
  client: LabelListClient,
  owner: string,
  repo: string,
  name: string,
): Promise<void> {
  (await knownByClient.get(client)?.get(`${owner}/${repo}`))?.delete(name);
}
