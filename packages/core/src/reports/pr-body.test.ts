import { renderPrWalkthrough } from './pr-walkthrough.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import {
  briefSummaryLine,
  stripBriefIds,
  extractSpecIntent,
  PR_BODY_FOOTER,
  renderPrBody,
  summarizeIntent,
} from './pr-body.js';

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
  it('omits internal plan names and file lists from verification', () => {
    const specBody = '## Goal\nImprove reliability.\n## Tests\nevidencePlan: `secret.test.ts`\n- other.ts\n';
    const checkSummary = {
      passes: 3,
      failures: 1,
      skips: 2,
      total: 6,
      results: [
        {
          checker: 'evidence_plan',
          result: 'PASS' as const,
          details: 'ok',
          evidencePlanResults: [
            {
              kind: 'screenshot' as const,
              claim: 'evidencePlan `screen.ts`\nother.ts',
              status: 'PASS' as const,
              reason: 'ok',
            },
          ],
        },
      ],
    };
    const walkthrough = renderPrWalkthrough({ specBody, checkSummary });
    const body = renderPrBody({ summaryLine: 'Change.', specBody, checkSummary, walkthrough });
    for (const text of ['evidencePlan', 'secret.test.ts', 'other.ts', 'screen.ts']) expect(body).not.toContain(text);
    expect(body).toContain('Checkers: 3 pass, 1 fail, 2 skip');
    expect(body).toContain('Manual evidence: 1 recorded');
  });

  it('renders the short layout: summary, what changed, proof, risk, closes, footer', () => {
    const body = renderPrBody({
      summaryLine: 'Implements #42.',
      specBody: SPEC_BODY,
      checkSummary: { passes: 3, failures: 0, skips: 1, total: 4, results: [] },
      reworkRounds: 2,
      risk: 'Only the uploader.',
      closes: workKeyFromIssue(42),
    });

    expect(body).toBe(
      [
        '## Summary\nImplements #42.',
        '## What changed\nUploads fail on a transient 503 and the user has to start over. Retry so a blip does not lose work. Wrap `upload()` in `src/uploader.ts` with a 3-attempt exponential backoff.',
        '## Proof\nCheckers: 3 pass, 0 fail, 1 skip · Rework rounds: 2',
        '**Risk:** Only the uploader.',
        'Closes #42',
        PR_BODY_FOOTER,
      ].join('\n\n'),
    );
  });

  it('caps What changed at 3 sentences and 600 chars on a sentence boundary', () => {
    const sentence = `${'word '.repeat(17)}ends here.`;
    const goal = Array.from({ length: 10 }, () => sentence).join(' ');
    const body = renderPrBody({ summaryLine: 'x', specBody: `## Goal\n${goal}\n` });
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
      checkSummary: { passes: 1, failures: 0, skips: 0, total: 1, results: [] },
      closes: workKeyFromIssue(42),
    });
    const bare = renderPrBody({ summaryLine: 'Add a widget.' });

    for (const body of [full, bare]) {
      const lines = body.split('\n');
      expect(lines.at(-1)).toBe('This PR was made by Software Factory');
      expect(lines.slice(0, -1).some((l) => l.includes('Software Factory'))).toBe(false);
    }
  });

  it.each(['  Custom {{repo}} footer  ', 'First line\nSecond line', '   '])('uses footer %j verbatim', (footer) => {
    const body = renderPrBody({ summaryLine: 'x', closes: workKeyFromIssue(42), footer });
    expect(body).toBe(`${renderPrBody({ summaryLine: 'x', closes: workKeyFromIssue(42), footer: '' })}\n\n${footer}`);
    expect(body).not.toContain(PR_BODY_FOOTER);
  });

  it.each([{ closes: workKeyFromIssue(42) }, { partOf: workKeyFromIssue(42) }, {}])(
    'removes an empty footer and its separator after %j',
    (issue) => {
      const body = renderPrBody({ summaryLine: 'x', ...issue, footer: '' });
      const lastSection = 'closes' in issue ? 'Closes #42' : 'partOf' in issue ? 'Part of #42' : 'Rework rounds: 0';
      expect(body.endsWith(lastSection)).toBe(true);
      expect(body).not.toContain(PR_BODY_FOOTER);
    },
  );

  it('renders a one-line Proof, with not run and 0 rounds by default', () => {
    const body = renderPrBody({ summaryLine: 'x' });
    expect(body).toContain('## Proof\nCheckers: not run · Rework rounds: 0\n\n');
  });

  it('omits the Risk line when risk is undefined or blank and flattens a multi-line risk', () => {
    expect(renderPrBody({ summaryLine: 'x' })).not.toMatch(/^\*\*Risk:\*\*/m);
    expect(renderPrBody({ summaryLine: 'x', risk: '   ' })).not.toMatch(/^\*\*Risk:\*\*/m);
    const body = renderPrBody({ summaryLine: 'x', risk: 'one\n  two\n\nthree' });
    expect(body).toContain('\n**Risk:** one two three\n');
  });

  it('renders Part of for a non-final slice and never a closing keyword', () => {
    const body = renderPrBody({ summaryLine: 'x', partOf: workKeyFromIssue(7) });
    expect(body).toContain('Part of #7');
    expect(body.endsWith(PR_BODY_FOOTER)).toBe(true);
    expect(body).not.toMatch(/Closes/);
  });

  it('renders a WorkKey closes as "Closes #N"', () => {
    const body = renderPrBody({ summaryLine: 'x', closes: workKeyFromIssue(42) });
    expect(body).toContain('Closes #42');
  });

  it('prefers Closes when both closes and partOf are set', () => {
    const body = renderPrBody({
      summaryLine: 'x',
      closes: workKeyFromIssue(7),
      partOf: workKeyFromIssue(7),
    });
    expect(body).toContain('Closes #7');
    expect(body.endsWith(PR_BODY_FOOTER)).toBe(true);
    expect(body).not.toMatch(/Part of/);
  });

  it('omits What changed and the Closes line when there is no spec and no issue', () => {
    const body = renderPrBody({ summaryLine: 'Add a widget.' });

    expect(body).not.toContain('## What changed');
    for (const old of ['## Why', '## How', '## Tests', '## Verification']) expect(body).not.toContain(old);
    expect(body).not.toContain('Closes #');
  });
});

describe('renderPrBody changed files', () => {
  it('never lists changed files or a diff stat; the PR shows them already', () => {
    const body = renderPrBody({
      summaryLine: 'Implements #42.',
      specBody: SPEC_BODY,
      checkSummary: { passes: 1, failures: 0, skips: 0, total: 1, results: [] },
      risk: 'Only the uploader.',
      walkthrough: '### Intent\n- x',
      closes: workKeyFromIssue(42),
    });
    expect(body).not.toMatch(/changed files|files changed/i);
    expect(body).not.toContain('<details>');
    expect(body).not.toMatch(/\|\s*\d+\s*[+-]+/);
  });
});

describe('renderPrBody walkthrough (#3623)', () => {
  const base = { summaryLine: 'Implements #1.', closes: workKeyFromIssue(1) };

  it('embeds a Walkthrough section when a walkthrough is given', () => {
    const body = renderPrBody({ ...base, walkthrough: '### Intent\n- x' });
    expect(body).toContain('## Walkthrough\n### Intent\n- x');
    expect(body.indexOf('## Walkthrough')).toBeLessThan(body.indexOf('Closes #1'));
  });

  it('renders the same output when walkthrough is undefined', () => {
    expect(renderPrBody({ ...base, walkthrough: undefined })).toBe(renderPrBody(base));
    expect(renderPrBody(base)).not.toContain('Walkthrough');
  });
});

describe('renderPrBody stack order (#3348)', () => {
  it('renders stackOrder right after the Summary', () => {
    const body = renderPrBody({
      summaryLine: 'Implements slice 2/3 of #7.',
      stackOrder: '<!-- m -->\nLINE',
    });
    expect(body.indexOf('LINE')).toBeGreaterThan(body.indexOf('## Summary'));
    expect(body.indexOf('LINE')).toBeLessThan(body.indexOf('## Proof'));
  });
});

describe('briefSummaryLine', () => {
  it('describes the brief by its title and never by id, digest or path', () => {
    expect(briefSummaryLine('Add a widget')).toBe('Add a widget.');
    expect(briefSummaryLine('  Add a\nwidget.  ')).toBe('Add a widget.');
    const body = renderPrBody({ summaryLine: briefSummaryLine('Add a widget') });
    expect(body).not.toMatch(/local brief|sha256|\.md\b/i);
  });

  it('links the open PR the brief builds on', () => {
    expect(briefSummaryLine('Add a gadget', 41)).toBe('Add a gadget. Builds on #41.');
  });
});

describe('stripBriefIds', () => {
  it.each([
    ['ARA-12: Add a widget', 'Add a widget'],
    ['[ARA-12] Add a widget', 'Add a widget'],
    ['ARA-12 — Add a widget', 'Add a widget'],
    ['Add a widget (ARA-12)', 'Add a widget'],
    ['Implements a local brief (sha256 abc123). Add a widget', 'Add a widget'],
    ['ARA-7', 'Untitled change'],
  ])('removes the brief id or local-brief mention from %j', (input, expected) => {
    expect(stripBriefIds(input)).toBe(expected);
  });

  it('keeps ordinary hyphenated words like UTF-8', () => {
    expect(stripBriefIds('UTF-8 support for names')).toBe('UTF-8 support for names');
  });

  it('keeps the brief id out of the summary line', () => {
    expect(briefSummaryLine('ARA-3: Fix the parser.', 41)).toBe('Fix the parser. Builds on #41.');
  });
});
