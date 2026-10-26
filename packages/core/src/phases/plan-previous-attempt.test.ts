import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import { renderPreviousAttempt } from '../run/previous-attempt.js';
import type { IssueRunState } from '../types/index.js';
import { buildPlanPrompt } from './plan.js';

const building: IssueRunState = {
  issue: 36,
  lane: 'l',
  status: 'building',
  branch: 'b',
  worktree: '/w',
  specPath: '/s',
  model: 'm',
  route: 'claude',
  attempts: 1,
  startedAt: 't',
  updatedAt: 't',
};
const opts = {
  issue: workKeyFromIssue(36),
  issueTitle: 't',
  issueBody: 'b',
  specPath: '/tmp/spec.md',
  constitutionCtx: '',
};

describe('buildPlanPrompt previous attempt (#3373)', () => {
  it('buildPlanPrompt includes a previous-attempt note saying the last run stopped during BUILD without an outcome', () => {
    const prompt = buildPlanPrompt({ ...opts, previousAttempt: renderPreviousAttempt(building) });
    expect(prompt).toContain('## Previous attempt');
    expect(prompt).toContain('stopped during BUILD without an outcome');
    expect(prompt.indexOf('## Previous attempt')).toBeLessThan(prompt.indexOf('Steps:'));
  });

  it('has no Previous attempt section without the option', () => {
    expect(buildPlanPrompt(opts)).not.toContain('## Previous attempt');
    expect(buildPlanPrompt({ ...opts, previousAttempt: '' })).toBe(buildPlanPrompt(opts));
  });
});
