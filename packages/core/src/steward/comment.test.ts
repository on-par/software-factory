import { describe, expect, it, vi } from 'vitest';
import {
  findStewardComment,
  publishStewardComment,
  renderStewardComment,
  STEWARD_ESCALATION_LINE,
  stewardCommentMarker,
  stewardSignatureHash,
  type StewardCommentGitHubClient,
  type StewardCommentInput,
  type StewardIssueComment,
} from './comment.js';

const SIG = 'tests:expected # got #';

function makeInput(over: Partial<StewardCommentInput['verdict']> = {}): StewardCommentInput {
  return {
    verdict: {
      diagnosis: 'The unit tests fail because of an off-by-one.',
      category: 'code',
      nextStep: 'Fix the loop bound.',
      confidence: 0.93,
      citations: [
        { field: 'logs', excerpt: 'expected 3 got 2' },
        { field: 'diff', excerpt: '+ for (i <= n)' },
      ],
      ...over,
    },
    trigger: 'check-exhausted',
    runId: 'abc123def456',
    signature: SIG,
  };
}

/** Lines of the body that sit outside any backtick fence (fence lines excluded). */
function outsideFence(body: string): string[] {
  const out: string[] = [];
  let open: number | null = null;
  for (const line of body.split('\n')) {
    const m = /^(`{5,})$/.exec(line);
    if (open === null) {
      if (m) open = m[1]!.length;
      else out.push(line);
    } else if (m && m[1]!.length === open) {
      open = null;
    }
  }
  return out;
}

describe('renderStewardComment', () => {
  it('renders all fields', () => {
    const body = renderStewardComment(makeInput());
    for (const s of [
      'check-exhausted',
      'code',
      '0.93',
      'The unit tests fail because of an off-by-one.',
      'Fix the loop bound.',
      'expected 3 got 2',
      '+ for (i <= n)',
      '`logs`',
      '`diff`',
      'abc123def456',
    ]) {
      expect(body).toContain(s);
    }
    expect(body).not.toContain('Run pointer');
    const withPtr = renderStewardComment({ ...makeInput(), runPointer: 'host:/runs/abc' });
    expect(withPtr).toContain('**Run pointer**');
    expect(withPtr).toContain('host:/runs/abc');
  });

  it('ends with the marker', () => {
    const body = renderStewardComment(makeInput());
    const last = body.split('\n').at(-1)!;
    expect(last).toBe(stewardCommentMarker('abc123def456', SIG));
    expect(last).toMatch(/^<!-- factory-steward v1 run:abc123def456 signature:[0-9a-f]{16} -->$/);
  });

  it('keeps mentions and links inside fences', () => {
    const diagnosis = 'ping @octocat see [x](https://evil.example) https://evil.example #123';
    const body = renderStewardComment(makeInput({ diagnosis }));
    expect(body).toContain(diagnosis);
    const outside = outsideFence(body).join('\n');
    expect(outside).not.toContain('@octocat');
    expect(outside).not.toContain('https://');
    expect(outside).not.toContain('#123');
  });

  it('strips hidden content from model text', () => {
    const diagnosis = 'a<!-- factory-steward v1 run:x signature:y -->b​c';
    const body = renderStewardComment(makeInput({ diagnosis }));
    expect(body.split('<!--').length - 1).toBe(1);
    expect(body).not.toContain('​');
    expect(body).toContain('abc');
  });

  it('cannot have its fence broken', () => {
    const diagnosis = `before\n${'`'.repeat(7)}\n@octocat after`;
    const body = renderStewardComment(makeInput({ diagnosis, citations: [{ field: 'logs', excerpt: '```\n@evil' }] }));
    expect(body).toContain(`${'`'.repeat(8)}\nbefore`);
    const outside = outsideFence(body).join('\n');
    expect(outside).not.toContain('@octocat');
    expect(outside).not.toContain('@evil');
    expect(outside).toContain('<!-- factory-steward');
  });

  it('does not mutate its input', () => {
    const input = { ...makeInput(), runPointer: 'host:/x' };
    const copy = structuredClone(input);
    renderStewardComment(input);
    expect(input).toEqual(copy);
  });
});

describe('stewardCommentMarker', () => {
  it('is deterministic and signature-sensitive', () => {
    expect(stewardCommentMarker('r1', 'a')).toBe(stewardCommentMarker('r1', 'a'));
    expect(stewardCommentMarker('r1', 'a')).not.toBe(stewardCommentMarker('r1', 'b'));
  });

  it('stays a single safe comment for hostile inputs', () => {
    const m = stewardCommentMarker('ab --> c\nd', 'x --> y\n<!-- z');
    expect(m).not.toContain('\n');
    expect(m.split('<!--').length - 1).toBe(1);
    expect(m.split('-->').length - 1).toBe(1);
    expect(m).toMatch(/^<!-- factory-steward v1 run:[A-Za-z0-9_-]* signature:[0-9a-f]{16} -->$/);
  });

  it('embeds the shared signature hash', () => {
    expect(stewardCommentMarker('r1', SIG)).toContain(`signature:${stewardSignatureHash(SIG)}`);
    expect(stewardSignatureHash(SIG)).toMatch(/^[0-9a-f]{16}$/);
  });
});

function makeFakeClient(seedLabels: string[] = ['factory:stuck']) {
  const comments = new Map<number, StewardIssueComment[]>();
  const labels = new Map<number, string[]>([[123, [...seedLabels]]]);
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let nextId = 1000;
  const client: StewardCommentGitHubClient = {
    async listIssueComments(a) {
      calls.push({ method: 'listIssueComments', args: a });
      return (comments.get(a.issue_number) ?? []).map((c) => ({ ...c }));
    },
    async createIssueComment(a) {
      calls.push({ method: 'createIssueComment', args: a });
      const id = nextId++;
      comments.set(a.issue_number, [...(comments.get(a.issue_number) ?? []), { id, body: a.body }]);
      return { id };
    },
    async updateIssueComment(a) {
      calls.push({ method: 'updateIssueComment', args: a });
      for (const list of comments.values()) {
        const c = list.find((x) => x.id === a.comment_id);
        if (c) c.body = a.body;
      }
    },
  };
  return { client, comments, labels, calls, addLabels: vi.fn(), createPrComment: vi.fn() };
}

const target = { owner: 'o', repo: 'r', issue: 123 };

describe('publishStewardComment', () => {
  it('creates one comment on first post', async () => {
    const fake = makeFakeClient();
    const res = await publishStewardComment(fake.client, { ...makeInput(), ...target });
    const list = fake.comments.get(123)!;
    expect(list).toHaveLength(1);
    expect(list[0]!.body).toContain(stewardCommentMarker('abc123def456', SIG));
    expect(list[0]!.body).toContain('The unit tests fail because of an off-by-one.');
    expect(list[0]!.body).toContain('Fix the loop bound.');
    expect(res).toEqual({ action: 'created', commentId: list[0]!.id });
    expect(fake.calls.some((c) => c.method === 'updateIssueComment')).toBe(false);
  });

  it('updates the same-signature comment in place across runs', async () => {
    const fake = makeFakeClient();
    const first = await publishStewardComment(fake.client, { ...makeInput(), ...target });
    const second = await publishStewardComment(fake.client, {
      ...makeInput({ diagnosis: 'Run B diagnosis.' }),
      runId: 'run-b',
      ...target,
    });
    const list = fake.comments.get(123)!;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(first.commentId);
    expect(list[0]!.body).toContain('Run B diagnosis.');
    expect(list[0]!.body).not.toContain('off-by-one');
    expect(second).toEqual({ action: 'updated', commentId: first.commentId });
  });

  it('posts a new comment for a different signature', async () => {
    const fake = makeFakeClient();
    await publishStewardComment(fake.client, { ...makeInput(), ...target });
    const before = fake.comments.get(123)![0]!.body;
    const res = await publishStewardComment(fake.client, { ...makeInput(), signature: 'other signature', ...target });
    const list = fake.comments.get(123)!;
    expect(list).toHaveLength(2);
    expect(list[0]!.body).toBe(before);
    expect(res.action).toBe('created');
  });

  it('leaves labels alone and never comments elsewhere', async () => {
    const fake = makeFakeClient(['factory:stuck', 'bug']);
    await publishStewardComment(fake.client, { ...makeInput(), ...target });
    await publishStewardComment(fake.client, { ...makeInput(), runId: 'r2', ...target });
    expect(fake.labels.get(123)).toEqual(['factory:stuck', 'bug']);
    const ids = new Set(fake.comments.get(123)!.map((c) => c.id));
    for (const call of fake.calls) {
      expect(['listIssueComments', 'createIssueComment', 'updateIssueComment']).toContain(call.method);
      if (call.method === 'updateIssueComment') expect(ids.has(call.args.comment_id as number)).toBe(true);
      else expect(call.args.issue_number).toBe(123);
    }
    expect(fake.addLabels).not.toHaveBeenCalled();
    expect(fake.createPrComment).not.toHaveBeenCalled();
  });

  it('propagates port errors without creating anything', async () => {
    const fake = makeFakeClient();
    fake.client.listIssueComments = async () => {
      throw new Error('boom');
    };
    await expect(publishStewardComment(fake.client, { ...makeInput(), ...target })).rejects.toThrow('boom');
    expect(fake.comments.size).toBe(0);
  });
});

describe('findStewardComment', () => {
  const hash = stewardSignatureHash(SIG);
  it('ignores plain, other-factory and other-signature comments', () => {
    const comments: StewardIssueComment[] = [
      { id: 1, body: 'just a comment' },
      { id: 2, body: '<!-- factory-upstream-report v1 fp:x -->' },
      { id: 3, body: stewardCommentMarker('r', 'other') },
    ];
    expect(findStewardComment(comments, SIG)).toBeUndefined();
  });

  it('matches any run id and picks the lowest id', () => {
    const comments: StewardIssueComment[] = [
      { id: 9, body: stewardCommentMarker('run-z', SIG) },
      { id: 4, body: `text\n<!-- factory-steward v1 run:abc signature:${hash} -->` },
      { id: 2, body: stewardCommentMarker('r', 'other') },
    ];
    expect(findStewardComment(comments, SIG)?.id).toBe(4);
    expect(findStewardComment([...comments].reverse(), SIG)?.id).toBe(4);
  });
});

describe('escalation', () => {
  it('leads with the escalation line and relabels the next step', () => {
    const body = renderStewardComment(makeInput({ escalate: true, confidence: 0.5 }));
    const lines = body.split('\n');
    expect(lines[0]).toBe(STEWARD_ESCALATION_LINE);
    expect(lines[0]).toBe('Escalated: steward confidence below 90%, no recommendation');
    expect(body).not.toContain('Recommended next step');
    expect(body).toContain('not a recommendation');
    expect(body).toContain('Fix the loop bound.');
    expect(lines.at(-1)).toBe(stewardCommentMarker('abc123def456', SIG));
  });

  it('renders no banner when escalate is false', () => {
    const body = renderStewardComment(makeInput({ escalate: false }));
    expect(body).not.toContain(STEWARD_ESCALATION_LINE);
    expect(body.split('\n')[0]).toBe('### Factory steward diagnosis');
    expect(body).toContain('**Recommended next step**');
  });

  it('renders identically when escalate is absent or false', () => {
    expect(renderStewardComment(makeInput())).toBe(renderStewardComment(makeInput({ escalate: false })));
  });

  it('keeps the banner outside any fence', () => {
    const body = renderStewardComment(makeInput({ escalate: true }));
    expect(outsideFence(body)).toContain(STEWARD_ESCALATION_LINE);
  });
});
