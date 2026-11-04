// packages/core/src/run/feedback-round-hooks.test.ts — runIssue's feedback-round hooks: prepare, idle exit, re-plan note, publish (#3910)
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import {
  feedbackReplanNote,
  idleFeedbackRound,
  prepareFeedbackForRun,
  publishFeedbackForRun,
  revisedSpecSummary,
} from './feedback-round-hooks.js';
import type { FeedbackRoundPlan } from './feedback-round.js';

const dirs = createTempDirs();
afterAll(() => dirs.cleanup());

function octokitWith(opts: { comments?: object[]; permission?: string } = {}) {
  const posted: string[] = [];
  const listComments = vi.fn();
  const rest = {
    pulls: {
      get: vi.fn(async () => ({
        data: { state: 'open', head: { ref: 'b' }, user: { login: 'factory-bot' }, body: 'pr body' },
      })),
      listReviews: vi.fn(),
      listReviewComments: vi.fn(),
      update: vi.fn(async (_args: { body?: string }) => ({ data: {} })),
      requestReviewers: vi.fn(async () => ({ data: {} })),
    },
    issues: {
      listComments,
      createComment: vi.fn(async (a: { body: string }) => {
        posted.push(a.body);
        return { data: {} };
      }),
    },
    users: { getAuthenticated: vi.fn(async () => ({ data: { login: 'factory-bot' } })) },
    repos: {
      getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission: opts.permission ?? 'admin' } })),
    },
  };
  const octokit = Object.assign({} as Octokit, {
    rest,
    graphql: vi.fn(async () => ({ repository: { pullRequest: { reviewThreads: { nodes: [] } } } })),
    paginate: vi.fn(async (route: unknown) => (route === listComments ? (opts.comments ?? []) : [])),
  });
  return { octokit, posted };
}

const comment = { id: 5, user: { login: 'maint' }, body: 'rename foo', html_url: 'u' };
const request = (specPath: string) => ({
  feedbackRound: { prNumber: 7 },
  repo: 'o/r',
  specPath,
  branch: 'b',
  work: { brief: 'BRIEF' } as never,
  timeouts: { plan: 11, build: 1, check: 1, approval: 1, tests: 1 },
  trustedApprovers: ['maint'],
});
const workspace = { path: '/tmp/wt', dispose: async () => {} };

function portsFor(octokit: Octokit, output: string) {
  const run = vi.fn(async () => ({ model: 'm', output, exitCode: 0, attempts: [] }));
  return {
    ports: {
      octokit,
      router: { run } as never,
      workspace,
      gitExec: vi.fn(async () => ({ stdout: 'deadbeefcafe\n', stderr: '' })),
    },
    run,
  };
}

describe('feedback round hooks', () => {
  it('prepares a plan through the feedback_triage route using the spec file', async () => {
    const dir = dirs.makeSync('fb-');
    const specPath = join(dir, 'spec.md');
    writeFileSync(specPath, 'FROZEN SPEC');
    const { octokit } = octokitWith({ comments: [comment] });
    const { ports, run } = portsFor(
      octokit,
      JSON.stringify({ items: [{ id: 5, kind: 'comment', verdict: 'actionable' }] }),
    );
    const log = vi.fn();
    const plan = await prepareFeedbackForRun(request(specPath), ports, log);
    expect(plan?.summary).toBeDefined();
    expect(run).toHaveBeenCalledWith('feedback_triage', expect.stringContaining('FROZEN SPEC'), {
      worktree: '/tmp/wt',
      timeoutSeconds: 11,
    });
    expect(await prepareFeedbackForRun({ ...request(specPath), feedbackRound: undefined }, ports, log)).toBeUndefined();
    expect(
      await prepareFeedbackForRun({ ...request(specPath), resumeFrom: { phase: 'check' } as never }, ports, log),
    ).toBeUndefined();
  });

  it('falls back to the brief, and an empty round logs and ends idle without publishing', async () => {
    const { octokit, posted } = octokitWith();
    const { ports, run } = portsFor(octokit, '');
    const log = vi.fn();
    const plan = await prepareFeedbackForRun(request('/nonexistent/spec.md'), ports, log);
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('feedback_round_triaged', expect.stringContaining('no unhandled'));
    const outcome = await idleFeedbackRound(plan, request('/x'), ports, undefined, log);
    expect(outcome).toMatchObject({ state: 'ready', prNumber: 7, reworkRounds: 0, branch: 'b' });
    expect(posted).toEqual([]);
  });

  it('an idle round answers its questions without a head sha and an actionable plan is not idle', async () => {
    const { octokit, posted } = octokitWith({ comments: [comment] });
    const { ports } = portsFor(
      octokit,
      JSON.stringify({ items: [{ id: 5, kind: 'comment', verdict: 'question', answer: 'because' }] }),
    );
    const plan = await prepareFeedbackForRun(request('/nonexistent/spec.md'), ports, vi.fn());
    expect(await idleFeedbackRound(plan, request('/x'), ports, 'codex', vi.fn())).toMatchObject({ route: 'codex' });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('because');
    expect(ports.gitExec).not.toHaveBeenCalled();
    const actionable = {
      ...(plan as FeedbackRoundPlan),
      summary: (plan as FeedbackRoundPlan).summary ?? { failures: 1, passes: 0, skips: 0, total: 1, results: [] },
    };
    expect(await idleFeedbackRound(actionable, request('/x'), ports, undefined, vi.fn())).toBeUndefined();
    expect(await idleFeedbackRound(undefined, request('/x'), ports, undefined, vi.fn())).toBeUndefined();
  });

  it('publishes with the git head when SHIP gave none, and records the revised spec on a re-plan', async () => {
    const dir = dirs.makeSync('fb-');
    const specPath = join(dir, 'spec.md');
    writeFileSync(specPath, '# Spec\n\n## Goal\nDo X and Y\n\n## Files\nnope\n\n## Acceptance\n- X works\n- Y works\n');
    const { octokit, posted } = octokitWith({ comments: [comment] });
    const { ports } = portsFor(
      octokit,
      JSON.stringify({
        items: [{ id: 5, kind: 'comment', verdict: 'actionable', changesSpec: true, summary: 'adds Y' }],
      }),
    );
    const plan = await prepareFeedbackForRun(request(specPath), ports, vi.fn());
    await publishFeedbackForRun(request(specPath), ports, plan, undefined, vi.fn());
    expect(posted[0]).toContain('`deadbee`');
    const update = vi.mocked(octokit.rest.pulls.update).mock.calls[0]?.[0];
    expect(String(update?.body)).toContain('## Goal\nDo X and Y');
    expect(String(update?.body)).toContain('- Y works');
    expect(String(update?.body)).not.toContain('nope');
    await publishFeedbackForRun(request(specPath), ports, undefined, 'abc', vi.fn());
    expect(posted).toHaveLength(1);
  });

  it('tolerates a failing git rev-parse (falls back to "latest push")', async () => {
    const { octokit, posted } = octokitWith({ comments: [comment] });
    const { ports } = portsFor(octokit, '');
    ports.gitExec.mockRejectedValue(new Error('no git'));
    const plan = await prepareFeedbackForRun(request('/x'), ports, vi.fn());
    await publishFeedbackForRun(request('/x'), ports, plan, undefined, vi.fn());
    expect(posted[0]).toContain('Fixed in the latest push');
  });

  it('feedbackReplanNote appends the feedback only on a re-plan; revisedSpecSummary needs a readable spec', () => {
    const plan = {
      replan: true,
      summary: {
        failures: 1,
        passes: 0,
        skips: 0,
        total: 1,
        results: [{ checker: 'review_feedback', result: 'FAIL' as const, details: 'DETAILS' }],
      },
    } as FeedbackRoundPlan;
    expect(feedbackReplanNote('prev', plan)).toBe('prev\n\n## Review feedback that changes scope\n\nDETAILS');
    expect(feedbackReplanNote('', plan).startsWith('## Review')).toBe(true);
    expect(feedbackReplanNote('prev', { ...plan, replan: false })).toBe('prev');
    expect(feedbackReplanNote('prev', undefined)).toBe('prev');
    expect(revisedSpecSummary('/nonexistent/spec.md')).toBeUndefined();
    const specPath = join(dirs.makeSync('fb-'), 'spec.md');
    writeFileSync(specPath, 'no headings here');
    expect(revisedSpecSummary(specPath)).toBeUndefined();
  });
});
