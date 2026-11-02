import { expect, it } from 'vitest';
import { workKeyFromIssue } from '../work/work-key.js';
import { buildPlanPrompt } from './plan.js';

it('uses the factory size decision for stack mode without a template verdict', () => {
  const opts = {
    issue: workKeyFromIssue(1),
    issueTitle: 'Issue',
    issueBody: 'A general issue',
    specPath: '/tmp/spec',
    constitutionCtx: '',
  };
  const stack = buildPlanPrompt({ ...opts, stackSizeGate: true });
  expect(stack).toContain("Size is the factory's call, not yours. Do NOT print ESCALATE: about size");
  expect(buildPlanPrompt(opts)).toContain('asking to split the issue into smaller slices');
});
