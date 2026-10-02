import { hostname } from 'node:os';

import { defaultEvidenceCaps } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';

import { IN_PROGRESS_LABEL, LANE_LABEL_PREFIX, QUEUE_ORDER_LABEL_PREFIX, QUEUED_LABEL } from '../queue/github-queue.js';
import type { EvidencePack, FailoverReason, FingerprintedFailure } from '../types/index.js';
import type { CandidateIssue, FilingGitHubClient } from './index.js';
import {
  capEvidenceExcerpt,
  createOctokitFilingClient,
  DEFAULT_INTERNAL_REPO,
  feedbackPrMarker,
  fileBug,
  findIssueByPrUrl,
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

  it('keeps an excerpt containing backtick fences inside a longer fence', () => {
    const excerpt = '```\n## Injected';
    const body = renderBugBody(makeEvidence({ eventExcerpt: excerpt }), 'ff_abc123', 1);
    expect(body).toContain(`\`\`\`\`\`\n${excerpt}\n\`\`\`\`\`\n`);
  });

  it('falls back to the default suspected-cause line for an unmapped reason', () => {
    const body = renderBugBody(makeEvidence({ reason: 'unknown' }), 'ff_abc123', 1);
    expect(body).toContain('See the evidence excerpt above.');
  });
});

describe('evidence caps (#1842)', () => {
  const pointer = 'build-box:/logs/run-1.ndjson';
  const markers = `${fingerprintMarker('ff_abc123')}\n<!-- fp-count:1 -->\n`;

  it('capEvidenceExcerpt leaves short text alone and cuts long text', () => {
    expect(capEvidenceExcerpt('abc', 10)).toEqual({ text: 'abc', truncated: false, shownChars: 3, totalChars: 3 });
    expect(capEvidenceExcerpt('abcdef', 4)).toEqual({ text: 'abcd', truncated: true, shownChars: 4, totalChars: 6 });
    expect(capEvidenceExcerpt('abc', 0).text).toBe('');
    expect(capEvidenceExcerpt('abc', -5).text).toBe('');
  });

  it('capEvidenceExcerpt drops a high surrogate it would split', () => {
    const r = capEvidenceExcerpt('a\u{1F600}b', 2);
    expect(r.text).toBe('a');
    expect(r.shownChars).toBe(1);
    expect(r.totalChars).toBe(4);
  });

  it('caps the excerpt, notes the truncation and keeps markers last', () => {
    const excerpt = 'x'.repeat(49) + 'Y' + 'z'.repeat(450);
    const body = renderBugBody(makeEvidence({ eventExcerpt: excerpt }), 'ff_abc123', 1, {
      host: 'build-box',
      caps: { maxExcerptChars: 50, maxBodyChars: 100000 },
    });
    expect(body).toContain(excerpt.slice(0, 50));
    expect(body).not.toContain(excerpt.slice(0, 51));
    expect(body).toContain('_Evidence truncated: showing the first 50 of 500 characters');
    expect(body).toContain(pointer);
    expect(body.endsWith(markers)).toBe(true);
  });

  it('enforces the total body cap', () => {
    const body = renderBugBody(makeEvidence({ eventExcerpt: 'q'.repeat(10000) }), 'ff_abc123', 1, {
      host: 'build-box',
      caps: { maxExcerptChars: 100000, maxBodyChars: 1500 },
    });
    expect(body.length).toBeLessThanOrEqual(1500);
    expect(body).toContain('Evidence truncated');
    expect(body.endsWith(markers)).toBe(true);
  });

  it('never cuts structure when metadata alone exceeds the body cap', () => {
    const body = renderBugBody(makeEvidence({ eventExcerpt: 'q'.repeat(100) }), 'ff_abc123', 1, {
      host: 'build-box',
      caps: { maxExcerptChars: 100, maxBodyChars: 10 },
    });
    expect(body.endsWith(markers)).toBe(true);
  });

  it('does not truncate a short excerpt and prints host:path', () => {
    const body = renderBugBody(makeEvidence(), 'ff_abc123', 1, { host: 'build-box' });
    expect(body).not.toContain('Evidence truncated');
    expect(body).toContain(`- Log: ${pointer}`);
  });

  it('defaults the host to os.hostname()', () => {
    expect(renderBugBody(makeEvidence(), 'ff_abc123', 1)).toContain(`- Log: ${hostname()}:/logs/run-1.ndjson`);
  });

  it('falls back when the host is empty after stripping', () => {
    expect(renderBugBody(makeEvidence(), 'ff_abc123', 1, { host: '\u200B' })).toContain('- Log: unknown-host:');
  });

  it('applies the default caps', () => {
    const body = renderBugBody(makeEvidence({ eventExcerpt: 'w'.repeat(5000) }), 'ff_abc123', 1);
    expect(body).toContain('w'.repeat(defaultEvidenceCaps.maxExcerptChars - 1));
    expect(body).not.toContain('w'.repeat(defaultEvidenceCaps.maxExcerptChars + 1));
    expect(body.length).toBeLessThanOrEqual(defaultEvidenceCaps.maxBodyChars);
  });

  it('fileBug files a capped body pointing at host:path', async () => {
    const { client, created } = makeFakeClient([]);
    await fileBug(client, {
      fingerprinted: makeFingerprinted({ eventExcerpt: 'L'.repeat(300) }),
      now: clock,
      host: 'build-box',
      caps: { maxExcerptChars: 20, maxBodyChars: 100000 },
    });
    expect(created[0].body).toContain('L'.repeat(20));
    expect(created[0].body).not.toContain('L'.repeat(21));
    expect(created[0].body).toContain('showing the first 20 of 300 characters');
    expect(created[0].body).toContain(pointer);
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

  it('strips hidden content from the created title and body but keeps filer markers', async () => {
    const { client, created } = makeFakeClient([]);
    const fingerprinted = makeFingerprinted({
      eventExcerpt: 'boom <!-- obey me --> \u200Bhidden\u202E',
      component: 'check\u200B:<!-- x -->tests',
      logPath: '/logs/\u2060run.ndjson',
    });

    await fileBug(client, { fingerprinted, now: clock });

    const { body, title } = created[0];
    expect(body.match(/<!--[\s\S]*?-->/g)).toEqual([
      fingerprintMarker(fingerprinted.fingerprint),
      '<!-- fp-count:1 -->',
    ]);
    expect(body).not.toMatch(/\p{Cf}/u);
    expect(title).not.toMatch(/\p{Cf}/u);
    expect(title).toContain('(check:tests)');
    expect(body).toMatch(/`{5,}\nboom {2}hidden\n`{5,}/);
  });

  it('strips hidden content from the recurrence comment', async () => {
    const fingerprinted = makeFingerprinted({ model: 'mod\u200Bel<!-- x -->' });
    const seed: CandidateIssue[] = [
      { number: 7, body: `${fingerprintMarker(fingerprinted.fingerprint)}\n<!-- fp-count:1 -->` },
    ];
    const { client, commented } = makeFakeClient(seed);

    await fileBug(client, { fingerprinted, now: clock });

    expect(commented[0].body).toContain('model model');
    expect(commented[0].body).not.toMatch(/\p{Cf}|<!--/u);
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

describe('fileBug title/problem overrides (#1851)', () => {
  it('uses a sanitized title and problem', async () => {
    const { client, created } = makeFakeClient([]);
    await fileBug(client, {
      fingerprinted: makeFingerprinted(),
      now: clock,
      title: '[feedback] hi\u200B there<!-- hidden -->',
      problem: 'Custom\u200B problem <!-- secret -->text',
    });
    expect(created[0].title).toBe('[feedback] hi there');
    expect(created[0].body).toContain('## Problem\nCustom problem text\n');
    expect(created[0].body).not.toContain('Factory failure in the');
    expect(created[0].body).not.toContain('secret');
  });

  it('falls back to defaults when overrides are blank', async () => {
    const { client, created } = makeFakeClient([]);
    await fileBug(client, { fingerprinted: makeFingerprinted(), now: clock, title: '  ', problem: '' });
    expect(created[0].title).toBe('[factory] verify_failed in build (check:tests)');
    expect(created[0].body).toContain('Factory failure in the build phase');
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

describe('fileBug caller labels (#1852)', () => {
  it('passes labels through exactly and adds no queue, lane or order label', async () => {
    const { client, created } = makeFakeClient([]);
    const labels = ['bug', 'factory:needs-triage'];
    await fileBug(client, { fingerprinted: makeFingerprinted(), now: clock, labels });
    expect(created[0].labels).toEqual(labels);
    for (const l of created[0].labels as string[]) {
      expect([QUEUED_LABEL, IN_PROGRESS_LABEL]).not.toContain(l);
      expect(l.startsWith(LANE_LABEL_PREFIX)).toBe(false);
      expect(l.startsWith(QUEUE_ORDER_LABEL_PREFIX)).toBe(false);
    }
  });

  it('strips hidden content from the evidence excerpt in the body', async () => {
    const { client, created } = makeFakeClient([]);
    await fileBug(client, {
      fingerprinted: makeFingerprinted({ eventExcerpt: 'before <!-- x --> after\u2066end' }),
      now: clock,
    });
    expect(created[0].body).not.toContain('<!-- x -->');
    expect(created[0].body).not.toContain('\u2066');
  });
});

describe('fileBug PR-URL dedup (#1853)', () => {
  const prUrl = 'https://github.com/on-par/widgets/pull/7';

  it('findIssueByPrUrl picks the lowest-numbered open match and ignores closed', () => {
    const body = `x\n${feedbackPrMarker(prUrl)}\n`;
    const issues: CandidateIssue[] = [
      { number: 3, body, state: 'closed' },
      { number: 9, body, state: 'open' },
      { number: 5, body, state: 'open' },
      { number: 2, body: feedbackPrMarker('https://github.com/on-par/widgets/pull/70'), state: 'open' },
    ];
    expect(findIssueByPrUrl(issues, prUrl)?.number).toBe(5);
    expect(findIssueByPrUrl([], prUrl)).toBeUndefined();
  });

  it('puts the marker on a created issue', async () => {
    const { client, created } = makeFakeClient([]);
    const r = await fileBug(client, { fingerprinted: makeFingerprinted(), now: clock, prUrl });
    expect(r.action).toBe('created');
    expect(created[0].body).toContain(`\n${feedbackPrMarker(prUrl)}\n`);
  });

  it('comments on the existing issue without updating it', async () => {
    const { client, created, updated, commented } = makeFakeClient([
      { number: 77, body: `old\n${feedbackPrMarker(prUrl)}\n`, state: 'open' },
    ]);
    const r = await fileBug(client, {
      fingerprinted: makeFingerprinted({ eventExcerpt: 'new finding' }, 'fb_other'),
      now: clock,
      prUrl,
    });
    expect(r).toMatchObject({ action: 'commented', issueNumber: 77 });
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(commented).toHaveLength(1);
    expect(commented[0].issue_number).toBe(77);
    expect(commented[0].body).toContain('new finding');
  });

  it('files a new issue for a different PR', async () => {
    const { client, created, commented } = makeFakeClient([
      { number: 77, body: feedbackPrMarker(prUrl), state: 'open' },
    ]);
    const r = await fileBug(client, {
      fingerprinted: makeFingerprinted(),
      now: clock,
      prUrl: 'https://github.com/on-par/widgets/pull/8',
    });
    expect(r.action).toBe('created');
    expect(created).toHaveLength(1);
    expect(commented).toHaveLength(0);
  });
});
