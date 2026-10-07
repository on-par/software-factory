import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STEWARD_ESCALATION_LINE, stewardCommentMarker, stewardSignatureHash } from './comment.js';
import type { StewardCommentGitHubClient, StewardIssueComment } from './comment.js';
import { STEWARD_VERDICT_FILE, type StewardModelInvoker } from './diagnose.js';
import { STEWARD_PACKET_FILE } from './packet.js';
import { runSteward, type RunStewardInput, type RunStewardPorts } from './run.js';

const TITLE = 'Fix the thing';

function verdictJson(confidence: number): string {
  return JSON.stringify({
    diagnosis: 'The tests fail on a stale fixture.',
    category: 'test',
    nextStep: 'Refresh the fixture.',
    confidence,
    citations: [{ field: 'issue', excerpt: TITLE }],
  });
}

function memoryClient() {
  const comments: StewardIssueComment[] = [];
  const client: StewardCommentGitHubClient = {
    listIssueComments: vi.fn(async () => comments.map((c) => ({ ...c }))),
    createIssueComment: vi.fn(async ({ body }) => {
      const id = comments.length + 1;
      comments.push({ id, body });
      return { id };
    }),
    updateIssueComment: vi.fn(async ({ comment_id, body }) => {
      const c = comments.find((x) => x.id === comment_id);
      if (c) c.body = body;
    }),
  };
  return { comments, client };
}

describe('runSteward', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'steward-run-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const setup = (text: string) => {
    const mem = memoryClient();
    const invoke = vi.fn<StewardModelInvoker>(async () => ({ text }));
    const ports: RunStewardPorts = {
      runDir: dir,
      costsFile: join(dir, 'costs.jsonl'),
      invoke,
      comments: mem.client,
    };
    return { ...mem, invoke, ports };
  };
  const input = (overrides: Partial<RunStewardInput> = {}): RunStewardInput => ({
    runId: 'abc123abc123',
    repo: 'o/r',
    issue: { number: 7, title: TITLE, body: 'do the thing' },
    stuck: { trigger: 'check-exhausted', failureSignature: 'sig-1' },
    ...overrides,
  });

  it('writes the packet and verdict and creates one comment', async () => {
    const { ports, invoke, comments } = setup(verdictJson(0.95));
    const result = await runSteward(input(), ports);
    await expect(readFile(join(dir, STEWARD_PACKET_FILE), 'utf8')).resolves.toBeTruthy();
    await expect(readFile(join(dir, STEWARD_VERDICT_FILE), 'utf8')).resolves.toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(stewardCommentMarker('abc123abc123', 'sig-1'));
    expect(comments[0].body).toContain('check-exhausted');
    expect(result.comment?.action).toBe('created');
  });

  it('updates the same-signature comment on a second run', async () => {
    const { ports, comments } = setup(verdictJson(0.95));
    await runSteward(input(), ports);
    const second = await runSteward(input(), ports);
    expect(comments).toHaveLength(1);
    expect(second.comment?.action).toBe('updated');
  });

  it('publishes an escalation comment for a low-confidence verdict', async () => {
    const { ports, comments } = setup(verdictJson(0.5));
    await runSteward(input(), ports);
    expect(comments).toHaveLength(1);
    expect(comments[0].body.startsWith(STEWARD_ESCALATION_LINE)).toBe(true);
  });

  it('records a steward-error verdict but publishes no comment', async () => {
    const { ports, client } = setup('not json');
    const result = await runSteward(input(), ports);
    expect(result.verdict.reason).toBe('steward-error');
    expect(result.comment).toBeUndefined();
    await expect(readFile(join(dir, STEWARD_VERDICT_FILE), 'utf8')).resolves.toBeTruthy();
    expect(client.listIssueComments).not.toHaveBeenCalled();
    expect(client.createIssueComment).not.toHaveBeenCalled();
  });

  it('falls back to the trigger as the signature when none is carried', async () => {
    const { ports, comments } = setup(verdictJson(0.95));
    await runSteward(input({ stuck: { trigger: 'ship-failed' } }), ports);
    expect(comments[0].body).toContain(stewardCommentMarker('abc123abc123', 'ship-failed'));
    expect(comments[0].body).toContain(stewardSignatureHash('ship-failed'));
  });
});
