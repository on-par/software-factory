import { describe, expect, it } from 'vitest';

import { scoreIssueReadiness } from './index.js';

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
});
