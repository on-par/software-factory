import { describe, expect, it } from 'vitest';

import type { EvidencePack, FailoverReason, FingerprintedFailure } from '../types/index.js';
import type { CandidateIssue, FilingGitHubClient } from './index.js';
import {
  createOctokitFilingClient,
  DEFAULT_INTERNAL_REPO,
  fileBug,
  findMatchingIssue,
  fingerprintMarker,
  renderBugBody,
  renderOccurrenceComment,
  resolveTargetRepo,
} from './index.js';

const clock = () => new Date('2026-07-20T00:00:00.000Z');

function makeEvidence(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    repo: 'on-par/widgets',
    issue: '42',
    phase: 'build',
    model: 'claude-sonnet-5',
    reason: 'verify_failed',
    component: 'check:tests',
    origin: 'product',
    eventExcerpt: 'tests failed: 2 of 40',
    logPath: '/logs/run-1.ndjson',
    ...overrides,
  };
}

function makeFingerprinted(overrides: Partial<EvidencePack> = {}, fingerprint = 'ff_abc123'): FingerprintedFailure {
  return { fingerprint, evidence: makeEvidence(overrides) };
}

function makeFakeClient(seedIssues: CandidateIssue[]) {
  const created: any[] = [];
  const updated: any[] = [];
  const commented: any[] = [];
  let nextNumber = 1000;

  const client: FilingGitHubClient = {
    async listCandidateIssues(_input) {
      return seedIssues;
    },
    async createIssue(input) {
      created.push(input);
      const number = nextNumber++;
      return { number };
    },
    async updateIssue(input) {
      updated.push(input);
    },
    async commentIssue(input) {
      commented.push(input);
    },
  };

  return { client, created, updated, commented };
}

describe('resolveTargetRepo', () => {
  it('routes factory-internal faults to the internal repo', () => {
    expect(resolveTargetRepo(makeEvidence({ origin: 'factory-internal' }))).toBe(DEFAULT_INTERNAL_REPO);
  });

  it('routes product faults to the evidence repo', () => {
    expect(resolveTargetRepo(makeEvidence({ origin: 'product', repo: 'on-par/widgets' }))).toBe('on-par/widgets');
  });

  it('accepts a custom internal repo', () => {
    expect(resolveTargetRepo(makeEvidence({ origin: 'factory-internal' }), 'acme/internal-tools')).toBe(
      'acme/internal-tools',
    );
  });
});

describe('findMatchingIssue', () => {
  it('returns undefined when no body matches', () => {
    const issues: CandidateIssue[] = [{ number: 1, body: 'unrelated' }];
    expect(findMatchingIssue(issues, 'ff_abc123')).toBeUndefined();
  });

  it('skips empty bodies without throwing', () => {
    const issues: CandidateIssue[] = [{ number: 1, body: '' }];
    expect(findMatchingIssue(issues, 'ff_abc123')).toBeUndefined();
  });

  it('finds the issue carrying the marker', () => {
    const issues: CandidateIssue[] = [
      { number: 1, body: 'unrelated' },
      { number: 2, body: `some text\n${fingerprintMarker('ff_abc123')}` },
    ];
    expect(findMatchingIssue(issues, 'ff_abc123')?.number).toBe(2);
  });
});

describe('renderBugBody', () => {
  it('includes the house sections and both hidden markers', () => {
    const evidence = makeEvidence();
    const body = renderBugBody(evidence, 'ff_abc123', 1);
    expect(body).toContain('## Problem');
    expect(body).toContain('## Evidence');
    expect(body).toContain('## Suspected cause');
    expect(body).toContain(fingerprintMarker('ff_abc123'));
    expect(body).toContain('<!-- fp-count:1 -->');
    expect(body).toContain(evidence.eventExcerpt);
    expect(body).toContain('Implementation did not pass the verification gate.');
  });

  it('produces a non-empty suspected-cause line for every FailoverReason', () => {
    const reasons: FailoverReason[] = [
      'rate_limit',
      'usage_cap',
      'timeout',
      'error',
      'empty_response',
      'unavailable',
      'schema_invalid',
      'apply_failed',
      'verify_failed',
      'unknown',
    ];
    for (const reason of reasons) {
      const body = renderBugBody(makeEvidence({ reason }), 'ff_abc123', 1);
      const section = body.split('## Suspected cause')[1];
      expect(section?.trim().length).toBeGreaterThan(0);
    }
  });

  it('falls back to the default suspected-cause line for an unmapped reason', () => {
    const body = renderBugBody(makeEvidence({ reason: 'unknown' }), 'ff_abc123', 1);
    expect(body).toContain('See the evidence excerpt above.');
  });
});

describe('renderOccurrenceComment', () => {
  it('includes the recurrence count, timestamp, and fingerprint', () => {
    const evidence = makeEvidence();
    const comment = renderOccurrenceComment(evidence, 'ff_abc123', 2, clock);
    expect(comment).toContain('Recurrence #2');
    expect(comment).toContain(clock().toISOString());
    expect(comment).toContain('(fingerprint ff_abc123)');
  });

  it('includes the run id when provided', () => {
    const comment = renderOccurrenceComment(makeEvidence(), 'ff_abc123', 2, clock, 'run-9');
    expect(comment).toContain('run run-9');
  });

  it('omits the run id when not provided', () => {
    const comment = renderOccurrenceComment(makeEvidence(), 'ff_abc123', 2, clock);
    expect(comment).not.toContain('run run-9');
    expect(comment).not.toContain(', run ');
  });
});

describe('fileBug', () => {
  it('files a new bug on first occurrence', async () => {
    const { client, created, updated, commented } = makeFakeClient([]);
    const fingerprinted = makeFingerprinted();

    const result = await fileBug(client, { fingerprinted, now: clock });

    expect(result.action).toBe('created');
    expect(result.occurrences).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].labels).toContain('bug');
    expect(created[0].body).toContain(fingerprintMarker(fingerprinted.fingerprint));
    expect(created[0].body).toContain('<!-- fp-count:1 -->');
    expect(created[0].body).toContain('## Problem');
    expect(created[0].body).toContain('## Evidence');
    expect(created[0].body).toContain('## Suspected cause');
    expect(created[0].body).toContain(fingerprinted.evidence.eventExcerpt);
    expect(updated).toHaveLength(0);
    expect(commented).toHaveLength(0);
  });

  it('bumps an existing issue with a count marker instead of duplicating', async () => {
    const fingerprinted = makeFingerprinted();
    const seed: CandidateIssue[] = [
      {
        number: 7,
        body: `body\n${fingerprintMarker(fingerprinted.fingerprint)}\n<!-- fp-count:1 -->`,
      },
    ];
    const { client, created, updated, commented } = makeFakeClient(seed);

    const result = await fileBug(client, { fingerprinted, now: clock });

    expect(result.action).toBe('bumped');
    expect(result.occurrences).toBe(2);
    expect(result.issueNumber).toBe(7);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].body).toContain('<!-- fp-count:2 -->');
    expect(updated[0].body).not.toContain('<!-- fp-count:1 -->');
    expect(commented).toHaveLength(1);
    expect(commented[0].body).toContain('Recurrence #2');
    expect(commented[0].body).toContain(clock().toISOString());
  });

  it('defaults prior count to 1 and appends the marker when missing', async () => {
    const fingerprinted = makeFingerprinted();
    const seed: CandidateIssue[] = [
      {
        number: 7,
        body: `body\n${fingerprintMarker(fingerprinted.fingerprint)}`,
      },
    ];
    const { client, updated, commented } = makeFakeClient(seed);

    const result = await fileBug(client, { fingerprinted, now: clock });

    expect(result.occurrences).toBe(2);
    expect(updated[0].body).toContain('<!-- fp-count:2 -->');
    expect(commented[0].body).toContain('Recurrence #2');
  });

  it('routes the create path to the internal repo for a factory-internal fault', async () => {
    const fingerprinted = makeFingerprinted({ origin: 'factory-internal' });
    const { client, created } = makeFakeClient([]);

    const result = await fileBug(client, { fingerprinted, now: clock });

    expect(result.repo).toBe(DEFAULT_INTERNAL_REPO);
    expect(created[0].owner).toBe('on-par');
    expect(created[0].repo).toBe('software-factory');
  });

  it('routes the create path to the product repo for a product fault', async () => {
    const fingerprinted = makeFingerprinted({ origin: 'product', repo: 'acme/widgets' });
    const { client, created } = makeFakeClient([]);

    const result = await fileBug(client, { fingerprinted, now: clock });

    expect(result.repo).toBe('acme/widgets');
    expect(created[0].owner).toBe('acme');
    expect(created[0].repo).toBe('widgets');
  });

  it('accepts a custom internal repo override', async () => {
    const fingerprinted = makeFingerprinted({ origin: 'factory-internal' });
    const { client, created } = makeFakeClient([]);

    const result = await fileBug(client, { fingerprinted, now: clock, internalRepo: 'acme/internal-tools' });

    expect(result.repo).toBe('acme/internal-tools');
    expect(created[0].owner).toBe('acme');
    expect(created[0].repo).toBe('internal-tools');
  });
});

describe('createOctokitFilingClient', () => {
  function createOctokit() {
    const calls: any[] = [];
    const octokit = {
      rest: {
        issues: {
          listForRepo: async (args: any) => {
            calls.push(['issues.listForRepo', args]);
            return {
              data: [
                { number: 1, body: 'a bug', state: 'open' },
                { number: 2, body: null, state: 'closed' },
                { number: 3, body: 'a pr', state: 'open', pull_request: {} },
              ],
            };
          },
          create: async (args: any) => {
            calls.push(['issues.create', args]);
            return { data: { number: 55 } };
          },
          update: async (args: any) => {
            calls.push(['issues.update', args]);
            return { data: {} };
          },
          createComment: async (args: any) => {
            calls.push(['issues.createComment', args]);
            return { data: {} };
          },
        },
      },
    };
    return { octokit, calls };
  }

  it('maps listCandidateIssues to issues.listForRepo, excluding pull requests', async () => {
    const { octokit, calls } = createOctokit();
    const client = createOctokitFilingClient(octokit as any, { now: clock });

    const issues = await client.listCandidateIssues({ owner: 'on-par', repo: 'widgets' });

    expect(calls[0][0]).toBe('issues.listForRepo');
    expect(calls[0][1]).toMatchObject({ owner: 'on-par', repo: 'widgets', state: 'all', labels: 'bug', per_page: 100 });
    expect(typeof calls[0][1].since).toBe('string');
    expect(issues).toEqual([
      { number: 1, body: 'a bug', state: 'open' },
      { number: 2, body: '', state: 'closed' },
    ]);
  });

  it('maps createIssue to issues.create', async () => {
    const { octokit, calls } = createOctokit();
    const client = createOctokitFilingClient(octokit as any);

    const result = await client.createIssue({
      owner: 'on-par',
      repo: 'widgets',
      title: 'title',
      body: 'body',
      labels: ['bug'],
    });

    expect(result).toEqual({ number: 55 });
    expect(calls[0]).toEqual([
      'issues.create',
      { owner: 'on-par', repo: 'widgets', title: 'title', body: 'body', labels: ['bug'] },
    ]);
  });

  it('maps updateIssue to issues.update', async () => {
    const { octokit, calls } = createOctokit();
    const client = createOctokitFilingClient(octokit as any);

    await client.updateIssue({ owner: 'on-par', repo: 'widgets', issue_number: 7, body: 'new body' });

    expect(calls[0]).toEqual([
      'issues.update',
      { owner: 'on-par', repo: 'widgets', issue_number: 7, body: 'new body' },
    ]);
  });

  it('maps commentIssue to issues.createComment', async () => {
    const { octokit, calls } = createOctokit();
    const client = createOctokitFilingClient(octokit as any);

    await client.commentIssue({ owner: 'on-par', repo: 'widgets', issue_number: 7, body: 'a comment' });

    expect(calls[0]).toEqual([
      'issues.createComment',
      { owner: 'on-par', repo: 'widgets', issue_number: 7, body: 'a comment' },
    ]);
  });
});
