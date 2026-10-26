import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import { buildClaudePrompt, buildCommitOnlyPrompt } from '../phases/build-prompts.js';
import type { CheckSummary, CheckerOutput } from '../types/index.js';
import { MAX_LINES_OVERRIDE_RULE, maxLinesOverrideHint, withoutHumanOnlyLabels } from './max-lines-override.js';

function summary(...results: CheckerOutput[]): CheckSummary {
  const failures = results.filter((r) => r.result === 'FAIL').length;
  return { failures, passes: results.length - failures, skips: 0, total: results.length, results };
}

describe('max-lines override (#3466)', () => {
  it('never lets the factory apply max-lines:override and the max-lines park hint asks a human to apply it or split the file', () => {
    expect(withoutHumanOnlyLabels(['no-auto-merge', 'max-lines:override', ' MAX-LINES:OVERRIDE '])).toEqual([
      'no-auto-merge',
    ]);
    const hint = maxLinesOverrideHint(
      summary({ checker: 'tests', result: 'FAIL', details: 'File has too many lines' }),
    );
    expect(hint).toContain('max-lines:override');
    expect(hint).toContain('split the file');
    expect(maxLinesOverrideHint(summary({ checker: 'tests', result: 'FAIL', details: 'boom' }))).toBeUndefined();
    expect(
      maxLinesOverrideHint(summary({ checker: 'tests', result: 'PASS', details: 'too many lines' })),
    ).toBeUndefined();
  });

  it('puts the rule in both BUILD prompts', () => {
    const claude = buildClaudePrompt({ issue: workKeyFromIssue(1), branch: 'b', specPath: '/s', constitutionCtx: '' });
    const commitOnly = buildCommitOnlyPrompt({
      issue: workKeyFromIssue(1),
      specPath: '/s',
      constitutionCtx: '',
      spec: 'x',
    });
    expect(claude).toContain(MAX_LINES_OVERRIDE_RULE);
    expect(commitOnly).toContain(MAX_LINES_OVERRIDE_RULE);
  });
});
