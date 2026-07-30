import { describe, expect, it } from 'vitest';

import { buildFastPathSpec, isFastPathEligible } from './fast-path.js';

const completeIssue = `## Problem statement
The CLI prints an extra blank line.

## Acceptance criteria
- Given the status command runs, when it renders output, then it has no blank line.

## Scope
- Update packages/cli/src/status.ts and its test.
`;

describe('fast-path planning', () => {
  it('accepts a small, complete, explicitly scoped issue', () => {
    expect(isFastPathEligible({ issueBody: completeIssue, readinessPassed: true })).toBe(true);
  });

  it('rejects incomplete or unbounded work for the full PLAN phase', () => {
    expect(isFastPathEligible({ issueBody: completeIssue, readinessPassed: false })).toBe(false);
    expect(
      isFastPathEligible({
        issueBody: `${completeIssue}\n## Architecture\nDecide the future module boundary.`,
        readinessPassed: true,
      }),
    ).toBe(false);
  });

  it('creates a compact, validated Codex spec without a model call', () => {
    const spec = buildFastPathSpec({ issue: 12, title: 'Remove blank status line', issueBody: completeIssue });

    expect(spec.frontmatter.route).toBe('codex');
    expect(spec.frontmatter.design.openQuestions).toEqual([]);
    expect(spec.markdown).toContain('## Acceptance criteria');
    expect(spec.markdown).toContain('Update packages/cli/src/status.ts');
  });
});
