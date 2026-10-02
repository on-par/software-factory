import { describe, expect, it } from 'vitest';

import { findUnresolvedRegressions } from '../design/index.js';
import { UNTRUSTED_ISSUE_BODY_NOTICE } from '../utils/untrusted-input.js';
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
    expect(spec.frontmatter.design.behaviorDelta).toBeUndefined();
    expect(findUnresolvedRegressions(spec.frontmatter.design)).toEqual([]);
    expect(spec.markdown).toContain('## Acceptance criteria');
    expect(spec.markdown).toContain('Update packages/cli/src/status.ts');
  });
});

describe('fast-path spec untrusted body', () => {
  it('freezes the issue body only inside the untrusted block with the notice', () => {
    const { markdown } = buildFastPathSpec({ issue: 1840, title: 't', issueBody: completeIssue });
    expect(markdown).toContain(`<untrusted-issue-body>\n${completeIssue.trim()}\n</untrusted-issue-body>`);
    expect(markdown).toContain(UNTRUSTED_ISSUE_BODY_NOTICE);
    expect(markdown.split(completeIssue.trim()).length).toBe(2);
  });
});
