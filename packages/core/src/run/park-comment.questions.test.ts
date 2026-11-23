import { describe, expect, it } from 'vitest';

import { commentStoreOctokit } from '../test-support/comment-store.js';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  parkUnblockHint,
  publishParkComment,
  readParkState,
  renderParkComment,
  type ParkCommentInput,
} from './park-comment.js';

const K12 = workKeyFromIssue(12);

function input(overrides: Partial<ParkCommentInput> = {}): ParkCommentInput {
  return {
    issue: K12,
    reason: 'not-ready',
    message: 'the readiness judge returned not-ready',
    runId: 'run-1',
    branch: '-',
    ...overrides,
  };
}

const QUESTIONS = [
  { aspect: 'scope', text: 'Which endpoints are in scope?' },
  { aspect: 'acceptance', text: 'What response time counts as done?' },
];

describe('park comment questions (#3470)', () => {
  it('renders a numbered Questions section tagged by aspect, before the not-ready unblock hint', () => {
    const body = renderParkComment(input({ questions: QUESTIONS }));
    const lines = body.split('\n');
    const heading = lines.indexOf('**Questions**');
    expect(heading).toBeGreaterThan(lines.indexOf('**Why it parked**'));
    expect(lines.slice(heading + 2, heading + 4)).toEqual([
      '1. [scope] Which endpoints are in scope?',
      '2. [acceptance] What response time counts as done?',
    ]);
    const hint = lines.findIndex((l) => l.startsWith('**What unblocks this:**'));
    expect(hint).toBeGreaterThan(heading);
    expect(lines[hint]).toBe(`**What unblocks this:** ${parkUnblockHint('not-ready', K12)}`);
  });

  it('tells the author to edit the ticket description, that comments are not read, and how to unpark', () => {
    const hint = parkUnblockHint('not-ready', K12);
    expect(hint).toContain('answer the questions above by editing the ticket description');
    expect(hint).toContain('comments are not read');
    expect(hint).toContain('`factory unpark 12`');
  });

  it('puts @handles and URLs in inline code, strips hidden characters and collapses each question to one line', () => {
    const body = renderParkComment(
      input({
        questions: [{ aspect: 'deci​sion', text: 'Ask @octocat\nabout https://evil.example/x?<!-- hidden --> ok' }],
      }),
    );
    expect(body).toContain('1. [decision] Ask `@octocat` about `https://evil.example/x?` ok');
    expect(body).not.toContain('hidden');
    expect(body).not.toContain('​');
  });

  it('renders the same body as before when questions are absent or empty', () => {
    const without = renderParkComment(input());
    expect(renderParkComment(input({ questions: [] }))).toBe(without);
    expect(without).not.toContain('**Questions**');
  });

  it('keeps the park state readable with questions present', () => {
    const body = renderParkComment(input({ questions: QUESTIONS }));
    expect(readParkState([{ id: 1, body }], K12)).toMatchObject({ reason: 'not-ready', runId: 'run-1' });
  });

  it('publishes one comment and edits it in place when the questions change on a re-park', async () => {
    const f = commentStoreOctokit();
    const first = await publishParkComment({ octokit: f.octokit, repo: 'o/r', input: input({ questions: QUESTIONS }) });
    const second = await publishParkComment({
      octokit: f.octokit,
      repo: 'o/r',
      input: input({ questions: [{ aspect: 'other', text: 'Is the old API kept?' }] }),
    });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(f.store).toHaveLength(1);
    expect(f.store[0].body).toContain('1. [other] Is the old API kept?');
    expect(f.store[0].body).not.toContain('Which endpoints');
  });
});
