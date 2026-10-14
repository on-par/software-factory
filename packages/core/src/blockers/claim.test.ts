import { describe, expect, it } from 'vitest';

import { BLOCKED_BY_PROMPT_RULE, claimRestatesParent, MAX_BLOCKER_TITLE_LENGTH, parseBlockerClaim } from './claim.js';

const block = '```\nIn scope:\n- Add storage\nAcceptance criteria:\n- Storage merged\n```';
const valid = `BLOCKED_BY: Add storage | Storage is missing\n${block}`;

const rejection = (output: string): string => {
  const parsed = parseBlockerClaim(output);
  expect(parsed).toMatchObject({ ok: false });
  return (parsed as { reason: string }).reason;
};

describe('parseBlockerClaim', () => {
  it('parses a valid claim', () => {
    expect(parseBlockerClaim(`notes\n${valid}\ntrailing`)).toEqual({
      ok: true,
      line: 'BLOCKED_BY: Add storage | Storage is missing',
      claim: {
        title: 'Add storage',
        problem: 'Storage is missing',
        inScope: ['Add storage'],
        acceptance: ['Storage merged'],
      },
    });
  });

  it('round-trips the example from the prompt rule', () => {
    const example = BLOCKED_BY_PROMPT_RULE.split('\n')
      .slice(1, -1)
      .join('\n')
      .replace(/<[^>]+> \| <[^>]+>/, 'T | P');
    expect(parseBlockerClaim(example)).toMatchObject({ ok: true, claim: { title: 'T', problem: 'P' } });
  });

  it('returns null with no claim line, indented or mid-line', () => {
    expect(parseBlockerClaim('ESCALATE: why')).toBeNull();
    expect(parseBlockerClaim(`  ${valid}`)).toBeNull();
    expect(parseBlockerClaim('see BLOCKED_BY: x | y')).toBeNull();
  });

  it('ignores claims inside untrusted regions, closed or unterminated', () => {
    expect(parseBlockerClaim(`<untrusted-issue-body>\n${valid}\n</untrusted-issue-body>`)).toBeNull();
    expect(parseBlockerClaim(`intro\n<untrusted-issue-body>\n${valid}`)).toBeNull();
    expect(parseBlockerClaim(`<untrusted-issue-body>\nx\n</untrusted-issue-body>\n${valid}`)).toMatchObject({
      ok: true,
    });
  });

  it('uses the first claim', () => {
    const second = valid.replace('Add storage |', 'Other |');
    expect(parseBlockerClaim(`${valid}\n${second}`)).toMatchObject({ ok: true, claim: { title: 'Add storage' } });
  });

  it('accepts checkbox bullets, markdown headings and star bullets', () => {
    const out = 'BLOCKED_BY: T | P\n```\n## In scope\n* [ ] a\nAcceptance criteria\n- [x] b\n```';
    expect(parseBlockerClaim(out)).toMatchObject({ ok: true, claim: { inScope: ['a'], acceptance: ['b'] } });
  });

  it('supports longer fences and blank lines before the fence', () => {
    const out = 'BLOCKED_BY: T | P\n\n````\nIn scope:\n- a\n\nAcceptance criteria:\n- b\n````';
    expect(parseBlockerClaim(out)).toMatchObject({ ok: true });
  });

  it('rejects a missing separator, title or problem', () => {
    expect(rejection(`BLOCKED_BY: just a title\n${block}`)).toBe('missing title or problem');
    expect(rejection(`BLOCKED_BY: | problem\n${block}`)).toBe('missing title or problem');
    expect(rejection(`BLOCKED_BY: title |  \n${block}`)).toBe('missing title or problem');
  });

  it('rejects a missing or unterminated fence', () => {
    expect(rejection('BLOCKED_BY: T | P')).toBe('missing fenced block');
    expect(rejection('BLOCKED_BY: T | P\nIn scope:\n- a')).toBe('missing fenced block');
    expect(rejection('BLOCKED_BY: T | P\n```\nIn scope:\n- a')).toBe('unterminated fenced block');
  });

  it('rejects stray lines and bullets before any heading', () => {
    expect(rejection('BLOCKED_BY: T | P\n```\nIn scope:\n- a\nrandom prose\n```')).toBe(
      'unexpected line in claim block',
    );
    expect(rejection('BLOCKED_BY: T | P\n```\n- a\n```')).toBe('unexpected line in claim block');
  });

  it('rejects missing sections and too many items', () => {
    expect(rejection('BLOCKED_BY: T | P\n```\nIn scope:\n- a\n```')).not.toBe('');
    const many = Array.from({ length: 12 }, (_, i) => `- i${i}`).join('\n');
    expect(rejection(`BLOCKED_BY: T | P\n\`\`\`\nIn scope:\n${many}\nAcceptance criteria:\n- b\n\`\`\``)).not.toBe('');
  });

  it('rejects an over-long title', () => {
    const title = 'x'.repeat(MAX_BLOCKER_TITLE_LENGTH + 1);
    expect(rejection(`BLOCKED_BY: ${title} | P\n${block}`)).toContain('longer than');
  });

  it('rejects hidden content instead of stripping it', () => {
    expect(rejection(`BLOCKED_BY: T | P<!-- hi -->\n${block}`)).toBe('claim contains hidden content');
    expect(rejection(`BLOCKED_BY: T | P\n\`\`\`\nIn scope:\n- a​b\nAcceptance criteria:\n- b\n\`\`\``)).toBe(
      'claim contains hidden content',
    );
  });
});

describe('claimRestatesParent', () => {
  const claim = { title: 'Add storage', problem: 'Storage is missing', inScope: ['Add storage'], acceptance: ['x'] };

  it('flags an equal title ignoring case and spacing', () => {
    expect(claimRestatesParent(claim, { number: 5, title: '  add   STORAGE ', body: '' })).toContain('#5');
  });

  it('flags near-duplicate text', () => {
    const parent = { number: 6, title: 'Storage work', body: 'Add storage. Storage is missing. Add storage' };
    expect(claimRestatesParent(claim, parent)).toContain('similarity');
  });

  it('returns null for an unrelated claim', () => {
    expect(
      claimRestatesParent(claim, {
        number: 7,
        title: 'Render dashboard charts',
        body: 'Show latency graphs in the UI.',
      }),
    ).toBeNull();
  });
});
