import { describe, expect, it } from 'vitest';

import { extractSpecIntent, renderPrBody } from './pr-body.js';

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

describe('renderPrBody', () => {
  it('leads with why and how from the spec, then verification, then the collapsed diff stat', () => {
    const body = renderPrBody({
      summaryLine: 'Implements #42.',
      specBody: SPEC_BODY,
      diffStat: ' src/uploader.ts | 10 +++++++---',
      checkSummary: { passes: 3, failures: 0, skips: 1, total: 4, results: [] },
      closes: 42,
    });

    expect(body).toBe(
      [
        '## Summary\nImplements #42.',
        '## Why\nUploads fail on a transient 503 and the user has to start over. Retry so a blip does not lose work.',
        '## How\nWrap `upload()` in `src/uploader.ts` with a 3-attempt exponential backoff.\n### Edge cases\nDo not retry a 4xx.',
        '## Tests\nAdd `src/uploader.test.ts` cases; run `npm test`.',
        '## Verification\nCheckers: 3 pass, 0 fail, 1 skip. This PR passed independent verification by checker agents before shipping.',
        '<details>\n<summary>Changed files</summary>\n\n```\n src/uploader.ts | 10 +++++++---\n```\n\n</details>',
        'Closes #42',
      ].join('\n\n'),
    );
  });

  it('renders Part of for a non-final slice and never a closing keyword', () => {
    const body = renderPrBody({ summaryLine: 'x', diffStat: '', partOf: 7 });
    expect(body.endsWith('Part of #7')).toBe(true);
    expect(body).not.toMatch(/Closes/);
  });

  it('prefers Closes when both closes and partOf are set', () => {
    const body = renderPrBody({ summaryLine: 'x', diffStat: '', closes: 7, partOf: 7 });
    expect(body.endsWith('Closes #7')).toBe(true);
    expect(body).not.toMatch(/Part of/);
  });

  it('omits the intent sections and the Closes line when there is no spec and no issue', () => {
    const body = renderPrBody({ summaryLine: 'Implements local brief `b`.', diffStat: '' });

    expect(body).not.toContain('## Why');
    expect(body).not.toContain('## How');
    expect(body).not.toContain('## Tests');
    expect(body).not.toContain('Closes #');
    expect(body).not.toContain('Checkers:');
    expect(body).toContain('```\n\n```');
  });
});
