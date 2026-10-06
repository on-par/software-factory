import { describe, expect, it } from 'vitest';

import { extractSpecIntent, PR_BODY_FOOTER, renderPrBody, summarizeIntent } from './pr-body.js';

const SPEC_BODY = `# Spec: Add retry to the uploader (#42)
## Goal
Uploads fail on a transient 503 and the user has to start over. Retry so a blip does not lose work.
## Files / approach
Wrap \`upload()\` in \`src/uploader.ts\` with a 3-attempt exponential backoff.
### Edge cases
Do not retry a 4xx.
## Tests
Add \`src/uploader.test.ts\` cases; run \`npm test\`.
## Constitution compliance
N/A — no constitution
## Non-goals
Resumable uploads.
`;

describe('extractSpecIntent', () => {
  it('pulls the Goal, approach, and Tests sections and keeps sub-headings inside a section', () => {
    expect(extractSpecIntent(SPEC_BODY)).toEqual({
      goal: 'Uploads fail on a transient 503 and the user has to start over. Retry so a blip does not lose work.',
      approach:
        'Wrap `upload()` in `src/uploader.ts` with a 3-attempt exponential backoff.\n### Edge cases\nDo not retry a 4xx.',
      tests: 'Add `src/uploader.test.ts` cases; run `npm test`.',
    });
  });

  it('keeps a ## line inside a fenced code block as section content', () => {
    const intent = extractSpecIntent('## Files / approach\nAdd this:\n```md\n## Usage\n```\n## Tests\nrun it\n');
    expect(intent.approach).toBe('Add this:\n```md\n## Usage\n```');
    expect(intent.tests).toBe('run it');
  });

  it('returns undefined for missing or empty sections', () => {
    expect(extractSpecIntent('# Spec\n## Goal\n\n## Non-goals\nnone\n')).toEqual({
      goal: undefined,
      approach: undefined,
      tests: undefined,
    });
  });

  it('truncates a very long section', () => {
    const intent = extractSpecIntent(`## Goal\n${'x'.repeat(5000)}\n`);
    expect(intent.goal).toHaveLength(4000);
    expect(intent.goal?.endsWith('…')).toBe(true);
  });
});

const DETAILS =
  '<details>\n<summary>Changed files</summary>\n\n```\n src/uploader.ts | 10 +++++++---\n```\n\n</details>';

describe('renderPrBody', () => {
  it('renders the short layout: summary, what changed, proof, risk, diff stat, closes, footer', () => {
    const body = renderPrBody({
      summaryLine: 'Implements #42.',
      specBody: SPEC_BODY,
      diffStat: ' src/uploader.ts | 10 +++++++---',
      checkSummary: { passes: 3, failures: 0, skips: 1, total: 4, results: [] },
      reworkRounds: 2,
      risk: 'Only the uploader.',
      closes: 42,
    });

    expect(body).toBe(
      [
        '## Summary\nImplements #42.',
        '## What changed\nUploads fail on a transient 503 and the user has to start over. Retry so a blip does not lose work. Wrap `upload()` in `src/uploader.ts` with a 3-attempt exponential backoff.',
        '## Proof\nCheckers: 3 pass, 0 fail, 1 skip · Rework rounds: 2',
        '**Risk:** Only the uploader.',
        DETAILS,
        'Closes #42',
        PR_BODY_FOOTER,
      ].join('\n\n'),
    );
  });

  it('caps What changed at 3 sentences and 600 chars on a sentence boundary', () => {
    const sentence = `${'word '.repeat(17)}ends here.`;
    const goal = Array.from({ length: 10 }, () => sentence).join(' ');
    const body = renderPrBody({ summaryLine: 'x', specBody: `## Goal\n${goal}\n`, diffStat: '' });
    const text = /## What changed\n(.*)\n/.exec(body)?.[1] ?? '';

    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toMatch(/[.!?…]$/);
    expect(text.match(/[.!?…]/g)?.length).toBeLessThanOrEqual(3);
    expect(goal.startsWith(text)).toBe(true);
  });

  it('cuts a single over-long sentence with an ellipsis', () => {
    const text = summarizeIntent({ goal: 'word '.repeat(180).trim() });
    expect(text?.length).toBeLessThanOrEqual(600);
    expect(text?.endsWith('…')).toBe(true);
  });

  it('hard-cuts an over-long sentence with no spaces', () => {
    const text = summarizeIntent({ goal: 'x'.repeat(900) });
    expect(text).toHaveLength(600);
    expect(text?.endsWith('…')).toBe(true);
  });

  it('summarizeIntent flattens lists, drops code fences, and punctuates a trailing fragment', () => {
    expect(summarizeIntent({ goal: '- first thing\n```\ncode. here\n```\n2. second thing' })).toBe(
      'first thing second thing.',
    );
    expect(summarizeIntent({ goal: '### Only a heading' })).toBeUndefined();
    expect(summarizeIntent({})).toBeUndefined();
  });

  it('ends with the footer and mentions Software Factory nowhere else', () => {
    const full = renderPrBody({
      summaryLine: 'Implements #42.',
      specBody: '## Goal\nDo a thing.\n',
      diffStat: 'a',
      checkSummary: { passes: 1, failures: 0, skips: 0, total: 1, results: [] },
      closes: 42,
    });
    const bare = renderPrBody({ summaryLine: 'Implements local brief `b`.', diffStat: '' });

    for (const body of [full, bare]) {
      const lines = body.split('\n');
      expect(lines.at(-1)).toBe('This PR made possible by Software Factory.');
      expect(lines.slice(0, -1).some((l) => l.includes('Software Factory'))).toBe(false);
    }
  });

  it('renders a one-line Proof, with not run and 0 rounds by default', () => {
    const body = renderPrBody({ summaryLine: 'x', diffStat: '' });
    expect(body).toContain('## Proof\nCheckers: not run · Rework rounds: 0\n\n');
  });

  it('omits the Risk line when risk is undefined or blank and flattens a multi-line risk', () => {
    expect(renderPrBody({ summaryLine: 'x', diffStat: '' })).not.toMatch(/^\*\*Risk:\*\*/m);
    expect(renderPrBody({ summaryLine: 'x', diffStat: '', risk: '   ' })).not.toMatch(/^\*\*Risk:\*\*/m);
    const body = renderPrBody({ summaryLine: 'x', diffStat: '', risk: 'one\n  two\n\nthree' });
    expect(body).toContain('\n**Risk:** one two three\n');
  });

  it('renders Part of for a non-final slice and never a closing keyword', () => {
    const body = renderPrBody({ summaryLine: 'x', diffStat: '', partOf: 7 });
    expect(body).toContain('Part of #7');
    expect(body.endsWith(PR_BODY_FOOTER)).toBe(true);
    expect(body).not.toMatch(/Closes/);
  });

  it('prefers Closes when both closes and partOf are set', () => {
    const body = renderPrBody({ summaryLine: 'x', diffStat: '', closes: 7, partOf: 7 });
    expect(body).toContain('Closes #7');
    expect(body.endsWith(PR_BODY_FOOTER)).toBe(true);
    expect(body).not.toMatch(/Part of/);
  });

  it('omits What changed and the Closes line when there is no spec and no issue', () => {
    const body = renderPrBody({ summaryLine: 'Implements local brief `b`.', diffStat: '' });

    expect(body).not.toContain('## What changed');
    for (const old of ['## Why', '## How', '## Tests', '## Verification']) expect(body).not.toContain(old);
    expect(body).not.toContain('Closes #');
    expect(body).toContain('```\n\n```');
  });
});
