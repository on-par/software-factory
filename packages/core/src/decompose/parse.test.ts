import { checkInvest } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { MAX_DECOMPOSITION_STORIES, MIN_DECOMPOSITION_STORIES, parseDecomposition } from './parse.js';
import { scoreIssueReadiness } from '../readiness/index.js';

const COMPLETE_FACTORY_TASK_BODY = `
### Problem statement

The widget flickers on load.

### In scope

Fix the flicker in the widget renderer.

### Out of scope

Redesigning the widget.

### Acceptance criteria

- [ ] Widget no longer flickers on load
- [x] Regression test added

### Files or modules likely touched

src/widget.ts

### Verification

bash scripts/verify.sh

### Design artifact link

_No response_
`;

function oversizedFactoryTaskBody(): string {
  const inScopeItems = Array.from({ length: 7 }, (_, i) => `- item ${i + 1}`).join('\n');
  const acceptanceCriteria = Array.from({ length: 8 }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n');
  return COMPLETE_FACTORY_TASK_BODY.replace(
    '### In scope\n\nFix the flicker in the widget renderer.\n',
    `### In scope\n\n${inScopeItems}\n`,
  ).replace(
    '### Acceptance criteria\n\n- [ ] Widget no longer flickers on load\n- [x] Regression test added\n',
    `### Acceptance criteria\n\n${acceptanceCriteria}\n`,
  );
}

function validStory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'story',
    title: 'Build the retry button',
    role: 'ops team member',
    want: 'build the retry button',
    soThat: 'fewer support tickets',
    problemStatement: 'The export breaks weekly.',
    inScope: ['build the retry button'],
    outOfScope: ['automated retries'],
    acceptanceCriteria: [
      {
        name: 'Outcome: Fewer support tickets',
        given: ['the ops team'],
        when: ['click retry'],
        then: ['fewer support tickets'],
      },
    ],
    verification: [{ command: 'manual: confirm fewer support tickets', passWhen: 'fewer support tickets' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: ['INT-SCOPE-01'],
    ...overrides,
  };
}

function validDecomposition(storyOverrides: Record<string, unknown>[] = [{}, {}]): Record<string, unknown> {
  const stories = storyOverrides.map((overrides, i) => validStory({ title: `Story ${i + 1}`, ...overrides }));
  return {
    epic: {
      kind: 'epic',
      title: 'Epic: retry flow',
      why: 'Fewer support tickets.',
      doneWhen: ['The retry flow ships.'],
      children: stories.map((s) => s.title),
      labels: [],
    },
    stories,
  };
}

describe('parseDecomposition', () => {
  it('accepts a bare JSON object', () => {
    const result = parseDecomposition(JSON.stringify(validDecomposition()));
    expect(result.ok).toBe(true);
  });

  it('accepts a ```json fenced object', () => {
    const raw = '```json\n' + JSON.stringify(validDecomposition()) + '\n```';
    const result = parseDecomposition(raw);
    expect(result.ok).toBe(true);
  });

  it('accepts an object wrapped in prose', () => {
    const raw = `Here is the decomposition:\n${JSON.stringify(validDecomposition())}\nHope that helps!`;
    const result = parseDecomposition(raw);
    expect(result.ok).toBe(true);
  });

  it('rejects output with no JSON at all', () => {
    const result = parseDecomposition('I refuse to decompose this issue.');
    expect(result).toEqual({ ok: false, errors: ['no JSON object found in model output'] });
  });

  it('rejects malformed JSON', () => {
    const result = parseDecomposition('{ "epic": invalid }');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/^schema: json:/);
    }
  });

  it('rejects a schema-invalid payload (missing role)', () => {
    const decomposition = validDecomposition();
    const stories = decomposition.stories as Record<string, unknown>[];
    delete stories[0].role;
    const result = parseDecomposition(JSON.stringify(decomposition));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('schema:'))).toBe(true);
    }
  });

  it(`rejects fewer than ${MIN_DECOMPOSITION_STORIES} stories`, () => {
    const decomposition = validDecomposition([{}]);
    const result = parseDecomposition(JSON.stringify(decomposition));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('schema:'))).toBe(true);
    }
  });

  it(`rejects more than ${MAX_DECOMPOSITION_STORIES} stories`, () => {
    const decomposition = validDecomposition(Array.from({ length: 9 }, () => ({})));
    const result = parseDecomposition(JSON.stringify(decomposition));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('schema:'))).toBe(true);
    }
  });

  it('rejects a story with 6 in-scope items (INVEST small)', () => {
    const decomposition = validDecomposition([{ inScope: Array.from({ length: 6 }, (_, i) => `item ${i + 1}`) }, {}]);
    const result = parseDecomposition(JSON.stringify(decomposition));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('fails INVEST (small)'))).toBe(true);
    }
  });

  it('rejects a story whose want names a dependency cue (INVEST independent)', () => {
    const decomposition = validDecomposition([{ want: 'once the export ships, build the retry button' }, {}]);
    const result = parseDecomposition(JSON.stringify(decomposition));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('fails INVEST (independent)'))).toBe(true);
    }
  });

  it('rejects a story with empty outOfScope (INVEST negotiable)', () => {
    const decomposition = validDecomposition([{ outOfScope: [] }, {}]);
    const result = parseDecomposition(JSON.stringify(decomposition));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('fails INVEST (negotiable)'))).toBe(true);
    }
  });

  it('rejects an acceptance criterion with an empty then (schema requires a non-empty then)', () => {
    const decomposition = validDecomposition([
      { acceptanceCriteria: [{ name: 'Broken', given: [], when: ['click retry'], then: [] }] },
      {},
    ]);
    const result = parseDecomposition(JSON.stringify(decomposition));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('schema:') && e.includes('then'))).toBe(true);
    }
  });

  it('rejects epic.children that do not match the story titles', () => {
    const decomposition = validDecomposition();
    (decomposition.epic as Record<string, unknown>).children = ['Some other title', 'Yet another title'];
    const result = parseDecomposition(JSON.stringify(decomposition));
    expect(result).toEqual({
      ok: false,
      errors: ['epic children do not match the 2 proposed stories'],
    });
  });

  it('feeds a known-oversized fixture through the scorer and parser and confirms checkInvest passes every story', () => {
    const readiness = scoreIssueReadiness({ title: 'Fix widget flicker', body: oversizedFactoryTaskBody() });
    expect(readiness.sizeOk).toBe(false);

    const decomposition = validDecomposition();
    const result = parseDecomposition(JSON.stringify(decomposition));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decomposition.stories.every((s) => checkInvest(s).ok)).toBe(true);
      for (const story of result.decomposition.stories) {
        expect(story.inScope.length).toBeLessThanOrEqual(5);
        expect(story.acceptanceCriteria.length).toBeLessThanOrEqual(5);
      }
    }
  });
});
