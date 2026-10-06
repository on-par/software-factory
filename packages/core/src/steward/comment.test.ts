import { describe, expect, it } from 'vitest';
import { renderStewardComment, stewardCommentMarker, type StewardCommentInput } from './comment.js';

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
});
