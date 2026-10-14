// src/cli/github-stub.ts — offline GitHub client for FACTORY_GITHUB=stub (#2652)
//
// FACTORY_GITHUB=stub + FACTORY_GITHUB_STUB_DIR=<dir> swaps the real Octokit for an offline stub so the
// `factory ship` path runs without network access (CI). Unset/empty FACTORY_GITHUB changes nothing.
//
// <dir>/fixture.json (read lazily; missing file = empty fixture):
//   { "issues": { "7": { "title": "...", "body": "...", "labels": ["factory"], "state": "open" } },
//     "labels": ["factory"], "firstPrNumber": 1 }
// <dir>/calls.jsonl: one line per write, `{ "op": "pulls.create", "args": {...}, "at": "<ISO>" }`.
//   Shipping also records each `git push` as `{ "op": "git.push", "args": { branch, command, cwd } }`.
// Git itself stays real: push/fetch/ls-remote run against the configured `origin`, so a fully offline
// run needs a local bare-repo origin. Endpoints the stub does not serve reject with a named error.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Octokit } from '@octokit/rest';

export type GitHubMode = 'real' | 'stub';
export const GITHUB_STUB_FIXTURE_FILE = 'fixture.json';
export const GITHUB_STUB_CALLS_FILE = 'calls.jsonl';

export interface GitHubStubIssue {
  title: string;
  body?: string;
  labels?: string[];
  state?: 'open' | 'closed';
}
export interface GitHubStubFixture {
  /** Keyed by issue number as a string, e.g. "2652". */
  issues?: Record<string, GitHubStubIssue>;
  /** Repo label names served by issues.listLabelsForRepo. */
  labels?: string[];
  /** First number handed out by pulls.create. Defaults to 1. */
  firstPrNumber?: number;
}
/** One line of calls.jsonl. */
export interface GitHubStubCall {
  op: string;
  args: unknown;
  at: string;
}
/** Same shape as shipPhase's `run` option (core's CommandRunner is not exported). */
export type GitHubStubRunner = (
  command: string,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string }>;

export function resolveGitHubMode(env: NodeJS.ProcessEnv = process.env): GitHubMode {
  const v = (env.FACTORY_GITHUB ?? '').trim().toLowerCase();
  if (v === '') return 'real';
  if (v === 'stub') return 'stub';
  throw new Error(
    `FACTORY_GITHUB=${env.FACTORY_GITHUB} is not supported — unset it for the real GitHub client or set FACTORY_GITHUB=stub`,
  );
}

export function selectOctokit(env: NodeJS.ProcessEnv, real: () => Octokit): Octokit {
  if (resolveGitHubMode(env) !== 'stub') return real();
  const dir = env.FACTORY_GITHUB_STUB_DIR?.trim();
  if (!dir) throw new Error('FACTORY_GITHUB=stub needs FACTORY_GITHUB_STUB_DIR=<dir>');
  return createStubOctokit(resolve(dir));
}

interface StubPr {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  state: 'open';
}

function rejecting(path: string): () => Promise<never> {
  return () => Promise.reject(new Error(`FACTORY_GITHUB=stub: octokit.${path} is not served by the GitHub stub`));
}

/** Wraps an object so any key it does not define resolves to a function rejecting with a named error. */
function strict<T extends object>(path: string, target: T): T {
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'symbol' || key === 'then' || key in t) return t[key as keyof T];
      return rejecting(`${path}.${key}`);
    },
  });
}

export function createStubOctokit(dir: string, { now = () => new Date() }: { now?: () => Date } = {}): Octokit {
  mkdirSync(dir, { recursive: true });
  const fixturePath = join(dir, GITHUB_STUB_FIXTURE_FILE);
  const callsPath = join(dir, GITHUB_STUB_CALLS_FILE);

  let fixture: GitHubStubFixture | undefined;
  const load = (): GitHubStubFixture => {
    if (fixture) return fixture;
    let raw: string;
    try {
      raw = readFileSync(fixturePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return (fixture = {});
      throw err;
    }
    try {
      return (fixture = JSON.parse(raw) as GitHubStubFixture);
    } catch (err) {
      throw new Error(`FACTORY_GITHUB=stub: malformed ${fixturePath}: ${(err as Error).message}`, { cause: err });
    }
  };

  const record = (op: string, args: unknown): void => {
    const line: GitHubStubCall = { op, args, at: now().toISOString() };
    appendFileSync(callsPath, JSON.stringify(line) + '\n');
  };
  const notFound = (what: string): Error =>
    Object.assign(new Error(`FACTORY_GITHUB=stub: ${what} not in ${GITHUB_STUB_FIXTURE_FILE}`), { status: 404 });
  const issueFor = (n: number): GitHubStubIssue => {
    const issue = load().issues?.[String(n)];
    if (!issue) throw notFound(`issue #${n}`);
    return issue;
  };

  const prs: StubPr[] = [];
  let nextNumber: number | undefined;
  const takeNumber = (): number => {
    nextNumber ??= load().firstPrNumber ?? 1;
    return nextNumber++;
  };
  const toPullPayload = (p: StubPr) => ({
    number: p.number,
    head: { ref: p.head },
    base: { ref: p.base },
    title: p.title,
    state: p.state,
    draft: p.draft,
    merged_at: null,
    node_id: `PR_${p.number}`,
  });

  // A write that records its call, then resolves with a fixed payload.
  const write =
    (op: string, result: (args: any) => unknown = () => ({ data: {} })) =>
    async (args: unknown) => {
      record(op, args);
      return result(args);
    };

  const issues = {
    get: async ({ issue_number }: { issue_number: number }) => {
      const i = issueFor(issue_number);
      return {
        data: {
          number: issue_number,
          title: i.title,
          body: i.body ?? '',
          state: i.state ?? 'open',
          labels: (i.labels ?? []).map((name) => ({ name })),
        },
      };
    },
    listLabelsOnIssue: async ({ issue_number }: { issue_number: number }) => ({
      data: (issueFor(issue_number).labels ?? []).map((name) => ({ name })),
    }),
    listLabelsForRepo: async () => ({ data: (load().labels ?? []).map((name) => ({ name })) }),
    listComments: async () => ({ data: [] }),
    createComment: write('issues.createComment', () => ({ data: { id: takeNumber() } })),
    addLabels: write('issues.addLabels'),
    removeLabel: write('issues.removeLabel'),
    setLabels: write('issues.setLabels'),
    update: write('issues.update'),
    create: write('issues.create', () => ({ data: { number: takeNumber() } })),
  };

  const pulls = {
    list: async ({ head, state = 'open' }: { head?: string; state?: string }) => {
      if (state === 'closed') return { data: [] };
      const branch = head?.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
      return { data: prs.filter((p) => !branch || p.head === branch).map(toPullPayload) };
    },
    get: async ({ pull_number }: { pull_number: number }) => {
      const p = prs.find((x) => x.number === pull_number);
      return {
        data: p
          ? toPullPayload(p)
          : { number: pull_number, draft: true, node_id: `PR_${pull_number}`, head: { ref: '' } },
      };
    },
    create: async (args: { head: string; base: string; title: string; body?: string; draft?: boolean }) => {
      record('pulls.create', args);
      const number = takeNumber();
      prs.push({
        number,
        head: args.head,
        base: args.base,
        title: args.title,
        body: args.body ?? '',
        draft: args.draft ?? false,
        state: 'open',
      });
      return {
        data: {
          number,
          html_url: `stub://pull/${number}`,
          node_id: `PR_${number}`,
          head: { ref: args.head },
          draft: args.draft ?? false,
        },
      };
    },
    update: write('pulls.update'),
  };

  const checks = { listForRef: async () => ({ data: { total_count: 0, check_runs: [] } }) };

  const graphql = async (query: string, vars?: unknown) => {
    record('graphql', { query, vars });
    return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
  };

  const rest = strict('rest', {
    issues: strict('rest.issues', issues),
    pulls: strict('rest.pulls', pulls),
    checks: strict('rest.checks', checks),
  });
  // Namespaces the stub does not define at all (repos, git, ...) also reject by name.
  const restProxy = new Proxy(rest, {
    get(t, key) {
      if (typeof key === 'symbol' || key in t) return t[key as keyof typeof t];
      return strict(`rest.${key}`, {});
    },
  });

  // Deliberate subset of Octokit: only what the ship path touches; everything else rejects loudly.
  const stub: object = Object.assign(rejecting('request'), {
    rest: restProxy,
    graphql,
    request: rejecting('request'),
    paginate: rejecting('paginate'),
  });
  return stub as Octokit;
}

export function recordGitPushes(run: GitHubStubRunner, callsFile: string, branch: string): GitHubStubRunner {
  return async (command, options) => {
    if (/^git push\b/.test(command)) {
      const line: GitHubStubCall = {
        op: 'git.push',
        args: { branch, command, cwd: options?.cwd },
        at: new Date().toISOString(),
      };
      appendFileSync(callsFile, JSON.stringify(line) + '\n');
    }
    return run(command, options);
  };
}
