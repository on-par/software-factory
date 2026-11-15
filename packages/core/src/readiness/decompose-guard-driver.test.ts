// packages/core/src/readiness/decompose-guard-driver.test.ts — decomposeOversizedIssue's #728 pre-flight guard (closed issue, pending proposal, retries)

import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { decomposeOversizedIssue } from './decompose.js';
import { DECOMPOSE_PROPOSAL_MARKER } from './decompose-guard.js';

const story = (n: number) => ({
  title: `Story ${n}`,
  role: 'operator',
  want: `thing ${n} works`,
  soThat: 'value',
  problemStatement: `Problem ${n}`,
  inScope: [`scope ${n}`],
  outOfScope: ['other'],
  acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
  verification: [{ command: 'npm test', passWhen: 'passes' }],
  tracesTo: ['INT-PROBLEM-01'],
});

const VALID_DECOMPOSITION_JSON = JSON.stringify({
  epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: ['Story 1', 'Story 2'] },
  stories: [story(1), story(2)],
});

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'triage',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { triage: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const routes: RoutesConfig = { version: 1, routes: { decompose: { tier: 'triage', description: 'stub' } } };

const repo = 'on-par/software-factory';

function makeOctokit(
  opts: { state?: string; comments?: unknown[]; getError?: Error; stateful?: boolean; now?: Date } = {},
) {
  const posted: Array<{ issue_number: number; body: string }> = [];
  const created: unknown[] = [];
  const reads: string[] = [];
  const store: unknown[] = [...(opts.comments ?? [])];
  const createComment = async (args: { issue_number: number; body: string }) => {
    posted.push(args);
    const created_at = (opts.now ?? new Date()).toISOString();
    if (opts.stateful) store.push({ id: store.length + 1, body: args.body, created_at, user: { id: 1, type: 'Bot' } });
    return {};
  };
  const get = async () => {
    reads.push('get');
    if (opts.getError) throw opts.getError;
    return { data: { state: opts.state ?? 'open' } };
  };
  const listComments = async () => (reads.push('listComments'), { data: store });
  const issues = { createComment, create: async (args: unknown) => void created.push(args), get, listComments };
  const users = { getAuthenticated: async () => ({ data: { id: 1 } }) };
  const octokit = { rest: { issues, users }, request: async () => ({ data: [] }) } as any;
  return { octokit, posted, created, reads };
}

function makeLog() {
  const events: { type: string; msg: string }[] = [];
  return { log: (type: string, msg: string) => events.push({ type, msg }), events };
}

describe('decomposeOversizedIssue #728 guard', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  const base = {
    issue: 606,
    repo,
    title: 'Harden the import queue',
    body: 'body',
    worktree: '/tmp/wt',
    now,
  };
  const scripted = (n = 1) => {
    const stub = new StubModelExecutor({
      scripts: { decompose: Array.from({ length: n }, () => ({ output: VALID_DECOMPOSITION_JSON })) },
    });
    return { router: new ModelRouter(models, routes, false, stub), stub };
  };
  const ownProposal = (createdAt: Date) => ({
    id: 10,
    body: `## Proposed epic: x\n\n${DECOMPOSE_PROPOSAL_MARKER}`,
    created_at: createdAt.toISOString(),
    user: { id: 1, type: 'Bot' },
  });

  it('skips a closed issue without a model call, comment or filing (#728)', async () => {
    const { router, stub } = scripted();
    const { octokit, posted, created } = makeOctokit({ state: 'closed' });
    const { log, events } = makeLog();

    const result = await decomposeOversizedIssue({ ...base, router, octokit, log });

    expect(stub.calls).toEqual([]);
    expect(posted).toEqual([]);
    expect(created).toEqual([]);
    expect(result.posted).toBe(false);
    expect(result.skipped?.kind).toBe('issue-closed');
    expect(result.skipped?.reason).toMatch(/already closed/);
    expect(events.map((e) => e.type)).toContain('decompose_skipped');
  });

  it('skips when its own proposal inside the window has no human reply (#728)', async () => {
    const { router, stub } = scripted();
    const { octokit, posted } = makeOctokit({ comments: [ownProposal(new Date(now.getTime() - 3600_000))] });
    const { log } = makeLog();

    const result = await decomposeOversizedIssue({ ...base, router, octokit, log });

    expect(stub.calls).toEqual([]);
    expect(posted).toEqual([]);
    expect(result.skipped?.kind).toBe('proposal-pending');
  });

  it('posts again after a human reply (#728)', async () => {
    const reply = { id: 11, body: 'no', created_at: now.toISOString(), user: { id: 2, type: 'User' } };
    const { octokit, posted } = makeOctokit({
      comments: [ownProposal(new Date(now.getTime() - 3600_000)), reply],
    });
    const { log } = makeLog();

    const result = await decomposeOversizedIssue({ ...base, router: scripted().router, octokit, log });

    expect(result.posted).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.endsWith(DECOMPOSE_PROPOSAL_MARKER)).toBe(true);
  });

  it('notes an unverified guard in decompose_started when a GitHub read fails (#728)', async () => {
    const { octokit, posted } = makeOctokit({ getError: new Error('boom') });
    const { log, events } = makeLog();

    const result = await decomposeOversizedIssue({ ...base, router: scripted().router, octokit, log });

    expect(result.posted).toBe(true);
    expect(posted).toHaveLength(1);
    expect(events.find((e) => e.type === 'decompose_started')?.msg).toMatch(/guard unverified/);
  });

  it('three retries against a stateful mock post exactly one proposal comment (#728)', async () => {
    const { octokit, posted } = makeOctokit({ stateful: true, now });
    const { router } = scripted(3);
    const { log } = makeLog();

    for (let i = 0; i < 3; i++) await decomposeOversizedIssue({ ...base, router, octokit, log });

    expect(posted).toHaveLength(1);
  });

  it('slice mode (postComment: false) makes no GitHub reads (#728)', async () => {
    const { octokit, reads } = makeOctokit();
    const { log } = makeLog();

    const { router } = scripted();
    const result = await decomposeOversizedIssue({ ...base, router, octokit, log, postComment: false });

    expect(result.decomposition).toBeDefined();
    expect(reads).toEqual([]);
  });
});
