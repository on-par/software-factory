// packages/core/src/queue/test-support/fleet-store.ts — shared in-memory GitHub for the fleet simulator (#3150).

import type { QueueGitHubClient, QueueIssue } from '../github-queue.js';

/** In-memory shape of a queue issue comment (#3238). */
export interface FleetIssueComment {
  id: number;
  body: string;
  createdAt: string;
}

/** The #3238 comment methods, declared locally until they land on QueueGitHubClient. */
export interface FleetCommentMethods {
  createIssueComment(input: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<{ id: number }>;
  listIssueComments(input: { owner: string; repo: string; issue_number: number }): Promise<FleetIssueComment[]>;
  deleteIssueComment(input: { owner: string; repo: string; comment_id: number }): Promise<void>;
}

export type FleetSimClient = QueueGitHubClient & FleetCommentMethods;

export interface FleetIssueSeed {
  number: number;
  labels: string[];
}

export type FleetOp =
  | 'listOpenIssuesWithLabels'
  | 'getIssueLabels'
  | 'addLabels'
  | 'removeLabel'
  | 'createIssueComment'
  | 'listIssueComments'
  | 'deleteIssueComment';

export const DEFAULT_NOW = 1_700_000_000_000;

/** Runs `exec` against the store when the scheduler releases the step; returns the trace detail. */
export type FleetGate = <T>(
  op: FleetOp,
  issue: number | undefined,
  args: string,
  exec: () => T,
  fmt: (result: T) => string,
) => Promise<T>;

export interface FleetStore {
  labels: Map<number, Set<string>>;
  history: Array<Map<number, string[]>>;
  catalog: Set<string>;
  comments: Map<number, FleetIssueComment[]>;
  listOpenIssuesWithLabels(labels: readonly string[]): QueueIssue[];
  getIssueLabels(issue: number): string[];
  addLabels(issue: number, labels: readonly string[]): void;
  removeLabel(issue: number, name: string): void;
  ensureLabel(name: string): boolean;
  createIssueComment(issue: number, body: string): { id: number };
  listIssueComments(issue: number): FleetIssueComment[];
  deleteIssueComment(id: number): void;
  /** Sorted snapshot of the primary label state. */
  snapshot(): Map<number, string[]>;
  client(gate?: FleetGate): FleetSimClient;
}

export function createFleetStore(issues: readonly FleetIssueSeed[], options: { replicaLag?: number } = {}): FleetStore {
  const replicaLag = options.replicaLag ?? 0;
  const labels = new Map<number, Set<string>>();
  for (const seed of issues) labels.set(seed.number, new Set(seed.labels));
  const catalog = new Set<string>();
  const comments = new Map<number, FleetIssueComment[]>();
  let nextCommentId = 1;

  const snapshot = (): Map<number, string[]> =>
    new Map([...labels.entries()].sort((a, b) => a[0] - b[0]).map(([n, set]) => [n, [...set].sort()]));
  const history: Array<Map<number, string[]>> = [snapshot()];
  const commit = (): void => {
    history.push(snapshot());
  };
  const labelSet = (issue: number): Set<string> => {
    const set = labels.get(issue);
    if (!set) throw new Error(`fleet-sim: unknown issue #${issue}`);
    return set;
  };

  const store: FleetStore = {
    labels,
    history,
    catalog,
    comments,
    listOpenIssuesWithLabels(wanted) {
      const view = history[Math.max(0, history.length - 1 - replicaLag)] ?? history[0] ?? new Map();
      const out: QueueIssue[] = [];
      for (const [number, have] of view) {
        if (wanted.every((label) => have.includes(label))) out.push({ number, labels: [...have] });
      }
      return out;
    },
    getIssueLabels: (issue) => [...labelSet(issue)].sort(),
    addLabels(issue, added) {
      const set = labelSet(issue);
      for (const label of added) set.add(label);
      commit();
    },
    removeLabel(issue, name) {
      labelSet(issue).delete(name);
      commit();
    },
    ensureLabel(name) {
      if (catalog.has(name)) return false;
      catalog.add(name);
      return true;
    },
    createIssueComment(issue, body) {
      const id = nextCommentId++;
      const list = comments.get(issue) ?? [];
      list.push({ id, body, createdAt: new Date(DEFAULT_NOW + id * 1000).toISOString() });
      comments.set(issue, list);
      return { id };
    },
    listIssueComments: (issue) => [...(comments.get(issue) ?? [])].sort((a, b) => a.id - b.id),
    deleteIssueComment(id) {
      for (const [issue, list] of comments)
        comments.set(
          issue,
          list.filter((c) => c.id !== id),
        );
    },
    snapshot,
    client(gate) {
      const run: FleetGate = gate ?? ((_op, _issue, _args, exec) => Promise.resolve().then(exec));
      const listLabels = (l: readonly string[]): string => `[${l.join(', ')}]`;
      return {
        listOpenIssuesWithLabels: (input) =>
          run(
            'listOpenIssuesWithLabels',
            undefined,
            listLabels(input.labels),
            () => store.listOpenIssuesWithLabels(input.labels),
            (r) => `-> ${r.map((i) => `#${i.number}${listLabels(i.labels)}`).join(' ') || 'none'}`,
          ),
        getIssueLabels: (input) =>
          run(
            'getIssueLabels',
            input.issue_number,
            '',
            () => store.getIssueLabels(input.issue_number),
            (r) => `-> ${listLabels(r)}`,
          ),
        addLabels: (input) =>
          run(
            'addLabels',
            input.issue_number,
            listLabels(input.labels),
            () => store.addLabels(input.issue_number, input.labels),
            () => '',
          ),
        removeLabel: (input) =>
          run(
            'removeLabel',
            input.issue_number,
            input.name,
            () => store.removeLabel(input.issue_number, input.name),
            () => '',
          ),
        ensureLabel: (input) => Promise.resolve(store.ensureLabel(input.name)),
        createIssueComment: (input) =>
          run(
            'createIssueComment',
            input.issue_number,
            JSON.stringify(input.body),
            () => store.createIssueComment(input.issue_number, input.body),
            (r) => `-> id ${r.id}`,
          ),
        listIssueComments: (input) =>
          run(
            'listIssueComments',
            input.issue_number,
            '',
            () => store.listIssueComments(input.issue_number),
            (r) => `-> ${r.length} comments`,
          ),
        deleteIssueComment: (input) =>
          run(
            'deleteIssueComment',
            undefined,
            `comment ${input.comment_id}`,
            () => store.deleteIssueComment(input.comment_id),
            () => '',
          ),
      };
    },
  };
  return store;
}
