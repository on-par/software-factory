import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildFeedbackTitle,
  collectReviewFindings,
  createOctokitFeedbackClient,
  type FeedbackGitHubClient,
  parseFeedbackPrUrl,
  runFeedback,
} from './feedback.js';

const PR = 'https://github.com/acme/widgets/pull/7';
const now = () => new Date('2026-07-20T00:00:00.000Z');

function setup(opts: { headRef?: string; reviews?: any[]; comments?: any[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-'));
  const events = join(dir, 'events.ndjson');
  const ev = (ts: string, issue: string) => JSON.stringify({ ts, type: 'phase', issue, msg: 'x' });
  writeFileSync(
    events,
    [
      ev('2026-07-01T10:00:00.000Z', '42'),
      ev('2026-07-01T11:00:00.000Z', '42'),
      ev('2026-07-05T00:00:00.000Z', '43'),
    ].join('\n') + '\n',
  );
  const github: FeedbackGitHubClient = {
    async getPull() {
      return { headRef: opts.headRef ?? 'ship-it/42-foo', title: 'Add foo', url: PR };
    },
    async listReviews() {
      return (
        opts.reviews ?? [
          {
            user: 'rev',
            state: 'CHANGES_REQUESTED',
            body: 'Missing regression test',
            submittedAt: '2026-07-02T00:00:00Z',
          },
          { user: 'rev', state: 'APPROVED', body: '', submittedAt: '2026-07-03T00:00:00Z' },
        ]
      );
    },
    async listReviewComments() {
      return (
        opts.comments ?? [
          { user: 'rev', body: 'Rework commit lost', path: 'src/a.ts', line: 10, createdAt: '2026-07-02T01:00:00Z' },
        ]
      );
    },
  };
  const created: any[] = [];
  const filing = {
    async listCandidateIssues() {
      return [];
    },
    async createIssue(i: any) {
      created.push(i);
      return { number: 900 };
    },
    async updateIssue() {},
    async commentIssue() {},
  };
  const deps = {
    github,
    filing,
    paths: { events, plans: '/s/plans', logs: '/s/logs' },
    branchPrefix: 'ship-it',
    now,
    host: 'box',
  };
  return { deps, created, github };
}

describe('parseFeedbackPrUrl', () => {
  it('accepts PR urls and subpaths', () => {
    expect(parseFeedbackPrUrl('https://github.com/o/r/pull/7')).toEqual({
      owner: 'o',
      repo: 'r',
      number: 7,
      url: 'https://github.com/o/r/pull/7',
    });
    expect(parseFeedbackPrUrl(' https://github.com/o/r/pull/7/files ').number).toBe(7);
  });
  it('rejects non-PR input', () => {
    expect(() => parseFeedbackPrUrl('o/r#7')).toThrow(/not a GitHub pull request URL/);
    expect(() => parseFeedbackPrUrl('https://github.com/o/r/issues/7')).toThrow();
  });
});

describe('collectReviewFindings', () => {
  it('drops empty-body reviews and orders by time', async () => {
    const { github } = setup();
    const f = await collectReviewFindings(github, { owner: 'acme', repo: 'widgets', number: 7 });
    expect(f.map((x) => x.body)).toEqual(['Missing regression test', 'Rework commit lost']);
  });
});

describe('buildFeedbackTitle', () => {
  it('truncates the first line to 80 chars', () => {
    const t = buildFeedbackTitle([{ author: 'a', kind: 'review', body: `\n${'x'.repeat(100)}\nmore`, at: '1' }]);
    expect(t).toBe(`[feedback] ${'x'.repeat(80)}…`);
  });
  it('throws with nothing to title from', () => {
    expect(() => buildFeedbackTitle([])).toThrow(/no review findings/);
  });
});

describe('runFeedback', () => {
  it('files one bug + needs-triage issue in the factory repo', async () => {
    const { deps, created } = setup();
    const result = await runFeedback(PR, {}, deps);
    expect(result.action).toBe('created');
    expect(created).toHaveLength(1);
    const c = created[0];
    expect(`${c.owner}/${c.repo}`).toBe('on-par/software-factory');
    expect(c.labels).toEqual(['bug', 'factory:needs-triage']);
    expect(c.title).toBe('[feedback] Missing regression test');
    for (const s of [
      PR,
      'Missing regression test',
      'Rework commit lost',
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T11:00:00.000Z',
      'plans/issue-42.md',
      'logs/42',
    ]) {
      expect(c.body).toContain(s);
    }
    expect(c.body).not.toContain('2026-07-05');
  });

  it('uses --note as the title', async () => {
    const { deps, created } = setup();
    await runFeedback(PR, { note: 'planning gap' }, deps);
    expect(created[0].title).toBe('[feedback] planning gap');
    expect(created[0].body).toContain('Note: planning gap');
  });

  it('refuses with no findings and no note', async () => {
    const { deps, created } = setup({ reviews: [], comments: [] });
    await expect(runFeedback(PR, {}, deps)).rejects.toThrow(/no review findings/);
    expect(created).toHaveLength(0);
  });

  it('refuses an invalid URL before any network call', async () => {
    const { deps } = setup();
    deps.github.getPull = async () => {
      throw new Error('network');
    };
    await expect(runFeedback('nope', {}, deps)).rejects.toThrow(/not a GitHub pull request URL/);
  });

  it('still files for a non-factory branch without an event window', async () => {
    const { deps, created } = setup({ headRef: 'feature/x' });
    await runFeedback(PR, {}, deps);
    expect(created[0].body).toContain('not a factory branch');
    expect(created[0].body).toContain('none found in');
  });
});

describe('createOctokitFeedbackClient', () => {
  it('maps octokit fields', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          get: async () => ({ data: { head: { ref: 'ship-it/1-a' }, title: 'T', html_url: PR } }),
          listReviews: 'reviews',
          listReviewComments: 'comments',
        },
      },
      paginate: async (fn: string) =>
        fn === 'reviews'
          ? [{ user: null, state: 'COMMENTED', body: null, submitted_at: null, html_url: 'u1' }]
          : [
              {
                user: { login: 'bob' },
                body: 'b',
                path: 'p',
                line: null,
                original_line: 3,
                created_at: 't',
                html_url: 'u2',
              },
            ],
    };
    const c = createOctokitFeedbackClient(octokit);
    const ref = { owner: 'o', repo: 'r', number: 1 };
    expect(await c.getPull(ref)).toEqual({ headRef: 'ship-it/1-a', title: 'T', url: PR });
    expect(await c.listReviews(ref)).toEqual([
      { user: 'unknown', state: 'COMMENTED', body: '', submittedAt: '', url: 'u1' },
    ]);
    expect(await c.listReviewComments(ref)).toEqual([
      { user: 'bob', body: 'b', path: 'p', line: 3, createdAt: 't', url: 'u2' },
    ]);
  });
});
