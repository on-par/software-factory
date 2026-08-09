import { MAX_ACCEPTANCE_CRITERIA, MAX_IN_SCOPE } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { checkIssueSize, MAX_ACCEPTANCE_CRITERIA_ITEMS, MAX_IN_SCOPE_ITEMS } from './size.js';

const items = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i + 1}`).join('\n');
const checkboxes = (n: number) => Array.from({ length: n }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n');

describe('checkIssueSize', () => {
  it('passes at the boundary — 5 in-scope bullets and 5 checkbox criteria', () => {
    const result = checkIssueSize({ inScope: items(5), acceptanceCriteria: checkboxes(5) });
    expect(result).toEqual({ sizeOk: true });
  });

  it('fails when in-scope items exceed the limit', () => {
    const result = checkIssueSize({ inScope: items(6), acceptanceCriteria: checkboxes(2) });
    expect(result.sizeOk).toBe(false);
    expect(result.reason).toBe('too big: 6 in-scope items, 2 acceptance criteria');
  });

  it('fails when acceptance criteria exceed the limit', () => {
    const result = checkIssueSize({ inScope: items(2), acceptanceCriteria: checkboxes(6) });
    expect(result.sizeOk).toBe(false);
    expect(result.reason).toBe('too big: 2 in-scope items, 6 acceptance criteria');
  });

  it('does not count bullets inside a backtick-fenced block', () => {
    const inScope = [
      '- real item 1',
      '- real item 2',
      '```',
      ...Array.from({ length: 8 }, (_, i) => `- fenced ${i + 1}`),
      '```',
    ].join('\n');
    const result = checkIssueSize({ inScope, acceptanceCriteria: '' });
    expect(result.sizeOk).toBe(true);
  });

  it('does not count bullets inside a tilde-fenced block', () => {
    const inScope = [
      '- real item 1',
      '- real item 2',
      '~~~',
      ...Array.from({ length: 8 }, (_, i) => `- fenced ${i + 1}`),
      '~~~',
    ].join('\n');
    const result = checkIssueSize({ inScope, acceptanceCriteria: '' });
    expect(result.sizeOk).toBe(true);
  });

  it('does not count sub-bullets indented four or more spaces', () => {
    const inScope = ['- item 1', '- item 2', ...Array.from({ length: 8 }, (_, i) => `    - nested ${i + 1}`)].join(
      '\n',
    );
    const result = checkIssueSize({ inScope, acceptanceCriteria: '' });
    expect(result.sizeOk).toBe(true);
  });

  it('counts a prose-only section (no list markers) as 0 items', () => {
    const result = checkIssueSize({
      inScope: 'Just do the thing described above.',
      acceptanceCriteria: 'Looks good to me.',
    });
    expect(result).toEqual({ sizeOk: true });
  });

  it('passes with no reason for empty inputs', () => {
    const result = checkIssueSize({ inScope: '', acceptanceCriteria: '' });
    expect(result).toEqual({ sizeOk: true });
  });

  it('counts *, +, and ordered `1.` markers as list items', () => {
    const inScope = ['* item 1', '+ item 2', '1. item 3', '2) item 4', '- item 5', '- item 6'].join('\n');
    const result = checkIssueSize({ inScope, acceptanceCriteria: '' });
    expect(result.sizeOk).toBe(false);
    expect(result.reason).toBe('too big: 6 in-scope items, 0 acceptance criteria');
  });

  it('keeps its thresholds equal to the contracts INVEST gate (ADR-0010)', () => {
    expect(MAX_IN_SCOPE_ITEMS).toBe(MAX_IN_SCOPE);
    expect(MAX_ACCEPTANCE_CRITERIA_ITEMS).toBe(MAX_ACCEPTANCE_CRITERIA);
  });
});
