// src/filing/index.ts — Auto-file a fingerprinted bug with dedup + repo routing (#373).

import type { Octokit } from '@octokit/rest';

import type { EvidencePack, FailoverReason, FingerprintedFailure } from '../types/index.js';

/** Where factory-internal faults are filed when origin === 'factory-internal'. */
export const DEFAULT_INTERNAL_REPO = 'on-par/software-factory';
export const DEFAULT_BUG_LABELS = ['bug'] as const;

/** Hidden dedup marker embedded in every filed bug's body. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- fp:${fingerprint} -->`;
}

function countMarker(n: number): string {
  return `<!-- fp-count:${n} -->`;
}

const COUNT_RE = /<!-- fp-count:(\d+) -->/;

export interface CandidateIssue {
  number: number;
  body: string;
  state?: 'open' | 'closed';
}

export interface FilingGitHubClient {
  /** Open + recently-closed issues (impl decides the window) to scan for the marker. */
  listCandidateIssues(input: { owner: string; repo: string }): Promise<CandidateIssue[]>;
  createIssue(input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number }>;
  updateIssue(input: { owner: string; repo: string; issue_number: number; body: string }): Promise<void>;
  commentIssue(input: { owner: string; repo: string; issue_number: number; body: string }): Promise<void>;
}

export type FileBugAction = 'created' | 'bumped';

export interface FileBugInput {
  fingerprinted: FingerprintedFailure;
  now: () => Date;
  runId?: string;
  internalRepo?: string;
  labels?: readonly string[];
}

export interface FileBugResult {
  action: FileBugAction;
  repo: string;
  issueNumber: number;
  fingerprint: string;
  occurrences: number;
}

/** Repo routing (pure, exported for direct test). */
export function resolveTargetRepo(evidence: EvidencePack, internalRepo = DEFAULT_INTERNAL_REPO): string {
  return evidence.origin === 'factory-internal' ? internalRepo : evidence.repo;
}

/** Dedup match (pure, exported). */
export function findMatchingIssue(issues: readonly CandidateIssue[], fingerprint: string): CandidateIssue | undefined {
  const marker = fingerprintMarker(fingerprint);
  return issues.find((i) => (i.body ?? '').includes(marker));
}

const SUSPECTED_CAUSE_BY_REASON: Record<FailoverReason, string> = {
  rate_limit: 'The model provider rate-limited requests before the phase could finish.',
  usage_cap: 'The model provider usage cap was reached before the phase could finish.',
  timeout: 'The phase timed out before completing.',
  error: 'The harness reported an execution error.',
  empty_response: 'The model returned an empty response.',
  unavailable: 'The model or provider was unavailable.',
  schema_invalid: 'The model response did not match the expected schema.',
  apply_failed: 'The proposed patch failed to apply.',
  verify_failed: 'Implementation did not pass the verification gate.',
  unknown: 'See the evidence excerpt above.',
};

function suspectedCause(reason: FailoverReason): string {
  return SUSPECTED_CAUSE_BY_REASON[reason] ?? 'See the evidence excerpt above.';
}

/** House bug format with the two hidden dedup/count markers appended last. */
export function renderBugBody(evidence: EvidencePack, fingerprint: string, occurrences = 1): string {
  return `## Problem
Factory failure in the ${evidence.phase} phase (${evidence.component}) — reason: ${evidence.reason}, origin: ${evidence.origin}.

## Evidence
- Repo under work: ${evidence.repo}
- Issue under work: ${evidence.issue}
- Phase / component: ${evidence.phase} / ${evidence.component}
- Model: ${evidence.model}
- Classified reason: ${evidence.reason}
- Log: ${evidence.logPath}

\`\`\`
${evidence.eventExcerpt}
\`\`\`

## Suspected cause
${suspectedCause(evidence.reason)}

${fingerprintMarker(fingerprint)}
${countMarker(occurrences)}
`;
}

export function renderOccurrenceComment(
  evidence: EvidencePack,
  fingerprint: string,
  occurrences: number,
  now: () => Date,
  runId?: string,
): string {
  const runSuffix = runId ? `, run ${runId}` : '';
  return `Recurrence #${occurrences} at ${now().toISOString()} — issue ${evidence.issue}, phase ${evidence.phase}, model ${evidence.model}${runSuffix}. (fingerprint ${fingerprint})`;
}

export async function fileBug(client: FilingGitHubClient, input: FileBugInput): Promise<FileBugResult> {
  const { evidence, fingerprint } = input.fingerprinted;
  const target = resolveTargetRepo(evidence, input.internalRepo);
  const [owner, repo] = target.split('/');
  const issues = await client.listCandidateIssues({ owner, repo });
  const match = findMatchingIssue(issues, fingerprint);

  if (match) {
    const m = COUNT_RE.exec(match.body ?? '');
    const prior = m ? Number.parseInt(m[1], 10) : 1;
    const next = prior + 1;
    const newBody = COUNT_RE.test(match.body ?? '')
      ? (match.body ?? '').replace(COUNT_RE, countMarker(next))
      : `${match.body ?? ''}\n${countMarker(next)}`;
    await client.updateIssue({ owner, repo, issue_number: match.number, body: newBody });
    await client.commentIssue({
      owner,
      repo,
      issue_number: match.number,
      body: renderOccurrenceComment(evidence, fingerprint, next, input.now, input.runId),
    });
    return { action: 'bumped', repo: target, issueNumber: match.number, fingerprint, occurrences: next };
  }

  const labels = [...(input.labels ?? DEFAULT_BUG_LABELS)];
  const title = `[factory] ${evidence.reason} in ${evidence.phase} (${evidence.component})`;
  const { number } = await client.createIssue({
    owner,
    repo,
    title,
    body: renderBugBody(evidence, fingerprint, 1),
    labels,
  });
  return { action: 'created', repo: target, issueNumber: number, fingerprint, occurrences: 1 };
}

export interface OctokitFilingClientOptions {
  recentlyClosedDays?: number;
  now?: () => Date;
}

export function createOctokitFilingClient(octokit: Octokit, opts: OctokitFilingClientOptions = {}): FilingGitHubClient {
  const recentlyClosedDays = opts.recentlyClosedDays ?? 30;
  const now = opts.now ?? (() => new Date());

  return {
    async listCandidateIssues({ owner, repo }) {
      const since = new Date(now().getTime() - recentlyClosedDays * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'all',
        labels: 'bug',
        since,
        per_page: 100,
      });
      return data
        .filter((issue: { pull_request?: unknown }) => !issue.pull_request)
        .map((issue: { number: number; body?: string | null; state?: string }) => ({
          number: issue.number,
          body: issue.body ?? '',
          state: issue.state as 'open' | 'closed' | undefined,
        }));
    },
    async createIssue({ owner, repo, title, body, labels }) {
      const { data } = await octokit.rest.issues.create({ owner, repo, title, body, labels });
      return { number: data.number };
    },
    async updateIssue({ owner, repo, issue_number, body }) {
      await octokit.rest.issues.update({ owner, repo, issue_number, body });
    },
    async commentIssue({ owner, repo, issue_number, body }) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
    },
  };
}
