import { describe, expect, it } from 'vitest';

import { extractIssueSections, findSection, scoreIssueReadiness } from './index.js';

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

describe('scoreIssueReadiness', () => {
  it('scores a complete rendered factory-task body as fully ready', () => {
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body: COMPLETE_FACTORY_TASK_BODY });
    expect(result.template).toBe('factory-task');
    expect(result.score).toBe(1);
    expect(result.pass).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.sizeOk).toBe(true);
  });

  it('reports a missing Verification section', () => {
    const body = COMPLETE_FACTORY_TASK_BODY.replace(/### Verification\n\nbash scripts\/verify\.sh\n/, '');
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual(['Verification']);
    expect(result.score).toBeCloseTo(4 / 5);
  });

  it('reports Acceptance criteria missing its checkbox list when present but empty of checkboxes', () => {
    const body = COMPLETE_FACTORY_TASK_BODY.replace(
      /### Acceptance criteria\n\n- \[ \] Widget no longer flickers on load\n- \[x\] Regression test added\n/,
      '### Acceptance criteria\n\nLooks good to me.\n',
    );
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.pass).toBe(false);
    expect(result.missing).toContain('Acceptance criteria (checkbox list)');
  });

  it('treats a `_No response_` section as missing', () => {
    const body = COMPLETE_FACTORY_TASK_BODY.replace(
      /### Problem statement\n\nThe widget flickers on load\.\n/,
      '### Problem statement\n\n_No response_\n',
    );
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.missing).toContain('Problem statement');
  });

  it('treats a `None` section as missing', () => {
    const body = COMPLETE_FACTORY_TASK_BODY.replace(
      /### Problem statement\n\nThe widget flickers on load\.\n/,
      '### Problem statement\n\nNone\n',
    );
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.missing).toContain('Problem statement');
  });

  it('accepts ##-level headings and mixed-case labels', () => {
    const body = `
## problem STATEMENT

Something is wrong.

## In Scope

Fix it.

## OUT OF SCOPE

Nothing else.

## Acceptance Criteria

- [ ] it works

## verification

bash scripts/verify.sh
`;
    const result = scoreIssueReadiness({ title: 'Freeform', body });
    expect(result.template).toBe('factory-task');
    expect(result.pass).toBe(true);
  });

  it('accepts a heading with a parenthetical suffix, like "Acceptance criteria (Gherkin)"', () => {
    const body = COMPLETE_FACTORY_TASK_BODY.replace('### Acceptance criteria', '### Acceptance criteria (Gherkin)');
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.pass).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('findSection prefers an exact heading match over a prefix match when both exist', () => {
    const body = `
### Acceptance criteria

- [ ] exact section wins

### Acceptance criteria (Gherkin)

- [ ] this one should be ignored
`;
    const sections = extractIssueSections(body);
    expect(findSection(sections, 'Acceptance criteria')).toContain('exact section wins');
  });

  it('detects an epic from a [EPIC]-prefixed title', () => {
    const body = `
### Why

Because.

### Children

- [ ] #1

### Done when

All children close.
`;
    const result = scoreIssueReadiness({ title: '[EPIC] Ship the thing', body });
    expect(result.template).toBe('epic');
    expect(result.pass).toBe(true);
  });

  it('detects an epic from a Children heading even without an [EPIC] title', () => {
    const body = `
### Why

Because.

### Children

- [ ] #1

### Done when

All children close.
`;
    const result = scoreIssueReadiness({ title: 'Ship the thing', body });
    expect(result.template).toBe('epic');
    expect(result.pass).toBe(true);
  });

  it('detects a factory-bug from an Observed behavior heading', () => {
    const body = `
### Observed behavior

It crashes.

### Expected behavior

It should not crash.

### Reproduction steps

1. Click the button.
`;
    const result = scoreIssueReadiness({ title: 'Crash on click', body });
    expect(result.template).toBe('factory-bug');
    expect(result.pass).toBe(true);
  });

  it('scores a freeform body with no headings as factory-task, score 0, all fields missing', () => {
    const result = scoreIssueReadiness({ title: 'Do the thing', body: 'Please just do the thing, thanks.' });
    expect(result.template).toBe('factory-task');
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual([
      'Problem statement',
      'In scope',
      'Out of scope',
      'Acceptance criteria',
      'Verification',
    ]);
  });

  it('scores an empty body as 0', () => {
    const result = scoreIssueReadiness({ title: 'Empty', body: '' });
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
  });

  it('treats a heading with no content before the next heading as missing', () => {
    const body = `
### Problem statement

### In scope

Fix it.
`;
    const result = scoreIssueReadiness({ title: 'Freeform', body });
    expect(result.missing).toContain('Problem statement');
  });

  it('defaults an undefined title and body to empty strings instead of crashing', () => {
    const result = scoreIssueReadiness({ title: undefined as unknown as string, body: undefined as unknown as string });
    expect(result.template).toBe('factory-task');
    expect(result.score).toBe(0);
  });

  it('does not mistake a `#` comment inside a fenced code block for a heading', () => {
    const body = COMPLETE_FACTORY_TASK_BODY.replace(
      '### Acceptance criteria\n\n- [ ] Widget no longer flickers on load\n- [x] Regression test added\n',
      [
        '### Acceptance criteria',
        '',
        '```py',
        '# this comment starts with a hash and must not be read as a heading',
        'print("hi")',
        '```',
        '',
        '- [ ] Widget no longer flickers on load',
        '- [x] Regression test added',
        '',
      ].join('\n'),
    );
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.pass).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('flags an oversized factory-task body as sizeOk: false even though all fields are present', () => {
    const inScopeItems = Array.from({ length: 7 }, (_, i) => `- item ${i + 1}`).join('\n');
    const acceptanceCriteria = Array.from({ length: 8 }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n');
    const body = COMPLETE_FACTORY_TASK_BODY.replace(
      '### In scope\n\nFix the flicker in the widget renderer.\n',
      `### In scope\n\n${inScopeItems}\n`,
    ).replace(
      '### Acceptance criteria\n\n- [ ] Widget no longer flickers on load\n- [x] Regression test added\n',
      `### Acceptance criteria\n\n${acceptanceCriteria}\n`,
    );
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.score).toBe(1);
    expect(result.missing).toEqual([]);
    expect(result.sizeOk).toBe(false);
    expect(result.sizeReason).toMatch(/too big: 7 in-scope items, 8 acceptance criteria/);
  });

  it('reports sizeOk: true with no sizeReason at exactly 5 in-scope items and 5 criteria', () => {
    const inScopeItems = Array.from({ length: 5 }, (_, i) => `- item ${i + 1}`).join('\n');
    const acceptanceCriteria = Array.from({ length: 5 }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n');
    const body = COMPLETE_FACTORY_TASK_BODY.replace(
      '### In scope\n\nFix the flicker in the widget renderer.\n',
      `### In scope\n\n${inScopeItems}\n`,
    ).replace(
      '### Acceptance criteria\n\n- [ ] Widget no longer flickers on load\n- [x] Regression test added\n',
      `### Acceptance criteria\n\n${acceptanceCriteria}\n`,
    );
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.score).toBe(1);
    expect(result.pass).toBe(true);
    expect(result.sizeOk).toBe(true);
    expect(result.sizeReason).toBeUndefined();
  });

  it('fails the size gate on in-scope count alone', () => {
    const inScopeItems = Array.from({ length: 6 }, (_, i) => `- item ${i + 1}`).join('\n');
    const acceptanceCriteria = Array.from({ length: 3 }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n');
    const body = COMPLETE_FACTORY_TASK_BODY.replace(
      '### In scope\n\nFix the flicker in the widget renderer.\n',
      `### In scope\n\n${inScopeItems}\n`,
    ).replace(
      '### Acceptance criteria\n\n- [ ] Widget no longer flickers on load\n- [x] Regression test added\n',
      `### Acceptance criteria\n\n${acceptanceCriteria}\n`,
    );
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.sizeOk).toBe(false);
  });

  it('fails the size gate on acceptance criteria count alone', () => {
    const inScopeItems = Array.from({ length: 3 }, (_, i) => `- item ${i + 1}`).join('\n');
    const acceptanceCriteria = Array.from({ length: 6 }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n');
    const body = COMPLETE_FACTORY_TASK_BODY.replace(
      '### In scope\n\nFix the flicker in the widget renderer.\n',
      `### In scope\n\n${inScopeItems}\n`,
    ).replace(
      '### Acceptance criteria\n\n- [ ] Widget no longer flickers on load\n- [x] Regression test added\n',
      `### Acceptance criteria\n\n${acceptanceCriteria}\n`,
    );
    const result = scoreIssueReadiness({ title: 'Fix widget flicker', body });
    expect(result.sizeOk).toBe(false);
  });

  it('reports sizeOk: true with no sizeReason for an epic body with 9 bullets under Children', () => {
    const body = `
### Why

Because.

### Children

${Array.from({ length: 9 }, (_, i) => `- [ ] #${i + 1}`).join('\n')}

### Done when

All children close.
`;
    const result = scoreIssueReadiness({ title: '[EPIC] Ship the thing', body });
    expect(result.template).toBe('epic');
    expect(result.sizeOk).toBe(true);
    expect(result.sizeReason).toBeUndefined();
  });

  it('reports sizeOk: true with no sizeReason for a factory-bug body with 9 bullets under Reproduction steps', () => {
    const body = `
### Observed behavior

It crashes.

### Expected behavior

It should not crash.

### Reproduction steps

${Array.from({ length: 9 }, (_, i) => `- step ${i + 1}`).join('\n')}
`;
    const result = scoreIssueReadiness({ title: 'Crash on click', body });
    expect(result.template).toBe('factory-bug');
    expect(result.sizeOk).toBe(true);
    expect(result.sizeReason).toBeUndefined();
  });
});

describe('extractIssueSections', () => {
  it('keys sections by lowercased heading and ignores headings inside a fence', () => {
    const body = [
      '### Problem statement',
      '',
      'Something is wrong.',
      '',
      '### Acceptance criteria',
      '',
      '```py',
      '# not a heading',
      '```',
      '',
      '- [ ] it works',
      '',
    ].join('\n');

    const sections = extractIssueSections(body);

    expect(sections.get('problem statement')).toBe('Something is wrong.');
    expect(sections.get('acceptance criteria')).toBe('```py\n# not a heading\n```\n\n- [ ] it works');
    expect(sections.has('not a heading')).toBe(false);
  });
});
