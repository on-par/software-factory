// packages/product/src/export/github.test.ts (#476).

import { CONTRACTS_SCHEMA_VERSION, type Epic, type Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { ExportGitHubClient, ExportTarget } from './github.js';
import { exportToGitHub } from './github.js';
import type { ExportPlan } from './plan.js';

function buildStory(overrides: Partial<Story> = {}): Story {
  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'story',
    title: 'A story',
    role: 'user',
    want: 'a thing',
    soThat: 'value happens',
    problemStatement: 'p',
    inScope: ['s'],
    outOfScope: [],
    acceptanceCriteria: [{ name: 'AC', given: [], when: ['x'], then: ['y'], tracesTo: [] }],
    verification: [{ command: 'manual: confirm', passWhen: 'y' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: [],
    ...overrides,
  };
}

const STORY_1 = buildStory({ title: 'Story One' });
const STORY_2 = buildStory({ title: 'Story Two' });

const EPIC: Epic = {
  schemaVersion: CONTRACTS_SCHEMA_VERSION,
  kind: 'epic',
  title: 'Epic',
  why: 'why',
  doneWhen: ['done'],
  children: [STORY_1.title, STORY_2.title],
  labels: [],
  tracesTo: [],
};

function buildPlan(overrides: Partial<ExportPlan> = {}): ExportPlan {
  return {
    epic: EPIC,
    stories: [STORY_1, STORY_2],
    bundle: {
      files: [
        { path: 'intent.md', content: 'intent\n' },
        { path: 'readiness.md', content: 'readiness\n' },
      ],
    },
    ...overrides,
  };
}

const TARGET: ExportTarget = { owner: 'on-par', repo: 'widgets' };

function makeFakeClient(numberedFrom = 100) {
  const createIssueCalls: any[] = [];
  const commentIssueCalls: any[] = [];
  let nextNumber = numberedFrom;

  const client: ExportGitHubClient = {
    async createIssue(input) {
      createIssueCalls.push(input);
      return { number: nextNumber++, url: `https://github.com/${input.owner}/${input.repo}/issues/${nextNumber - 1}` };
    },
    async commentIssue(input) {
      commentIssueCalls.push(input);
    },
  };

  return { client, createIssueCalls, commentIssueCalls };
}

describe('exportToGitHub', () => {
  it('creates the epic first, then each story in plan order carrying "Part of #<epic>"', async () => {
    const { client, createIssueCalls } = makeFakeClient();
    const plan = buildPlan();

    await exportToGitHub(plan, TARGET, client);

    expect(createIssueCalls).toHaveLength(3);
    expect(createIssueCalls[0].title).toBe(EPIC.title);
    expect(createIssueCalls[0].owner).toBe('on-par');
    expect(createIssueCalls[0].repo).toBe('widgets');

    expect(createIssueCalls[1].title).toBe(STORY_1.title);
    expect(createIssueCalls[1].body).toContain('Part of #100');
    expect(createIssueCalls[2].title).toBe(STORY_2.title);
    expect(createIssueCalls[2].body).toContain('Part of #100');
  });

  it('attaches one commentIssue per bundle file to the epic issue, each headed by the bundle path', async () => {
    const { client, commentIssueCalls } = makeFakeClient();
    const plan = buildPlan();

    await exportToGitHub(plan, TARGET, client);

    expect(commentIssueCalls).toHaveLength(2);
    expect(commentIssueCalls[0].issue_number).toBe(100);
    expect(commentIssueCalls[0].body).toContain('## Design Bundle — intent.md');
    expect(commentIssueCalls[0].body).toContain('intent\n');
    expect(commentIssueCalls[1].body).toContain('## Design Bundle — readiness.md');
  });

  it('returns the created epic/story numbers and urls, and the bundle comment count', async () => {
    const { client } = makeFakeClient();
    const plan = buildPlan();

    const result = await exportToGitHub(plan, TARGET, client);

    expect(result.epic).toEqual({ kind: 'epic', title: EPIC.title, number: 100, url: expect.stringContaining('100') });
    expect(result.stories).toEqual([
      { kind: 'story', title: STORY_1.title, number: 101, url: expect.stringContaining('101') },
      { kind: 'story', title: STORY_2.title, number: 102, url: expect.stringContaining('102') },
    ]);
    expect(result.bundleComments).toBe(2);
  });

  it('handles a client that returns no url', async () => {
    const client: ExportGitHubClient = {
      async createIssue(_input) {
        return { number: 1 };
      },
      async commentIssue() {
        // no-op
      },
    };

    const result = await exportToGitHub(buildPlan({ stories: [], bundle: { files: [] } }), TARGET, client);

    expect(result.epic).toEqual({ kind: 'epic', title: EPIC.title, number: 1, url: undefined });
    expect(result.stories).toEqual([]);
    expect(result.bundleComments).toBe(0);
  });

  it('rejects and posts no comments when a client rejects on the second story', async () => {
    const commentIssueCalls: any[] = [];
    let calls = 0;
    const client: ExportGitHubClient = {
      async createIssue(_input) {
        calls++;
        if (calls === 3) {
          throw new Error('second story failed');
        }
        return { number: calls };
      },
      async commentIssue(input) {
        commentIssueCalls.push(input);
      },
    };

    await expect(exportToGitHub(buildPlan(), TARGET, client)).rejects.toThrow('second story failed');
    expect(commentIssueCalls).toEqual([]);
  });
});
