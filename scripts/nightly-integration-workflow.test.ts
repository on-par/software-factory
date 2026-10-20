import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  'continue-on-error'?: boolean;
}

const workflow = parse(
  readFileSync(new URL('../.github/workflows/nightly-integration.yml', import.meta.url), 'utf8'),
) as { jobs: { integration: { steps: Step[] } } };

const steps = workflow.jobs.integration.steps;

function stepNamed(name: string): Step {
  const step = steps.find((s) => s.name === name);
  if (!step) throw new Error(`step not found: ${name}`);
  return step;
}

const suite = steps.find((s) => s.id === 'integration');
const filing = stepNamed('File or update the failure issue');
const failStep = stepNamed('Fail the job when the integration suites failed');
const OUTCOME_FAILED = "steps.integration.outcome == 'failure'";

describe('nightly-integration workflow (#3315)', () => {
  it('fail step runs with always() when the integration suites failed and reports a filing failure separately', () => {
    expect(filing.id).toBe('file_issue');
    expect(failStep.if).toContain('always()');
    expect(failStep.if).toContain(OUTCOME_FAILED);
    expect(failStep.env?.FILE_OUTCOME).toContain('steps.file_issue.outcome');
    const errors = (failStep.run ?? '').split('\n').filter((l) => l.includes('::error::'));
    expect(errors[0]).toContain('::error::pipeline integration suites failed');
    expect(errors[1]).toMatch(/filing/);
    expect(failStep.run).toContain('"$FILE_OUTCOME" = "failure"');
  });

  it('filing step creates the ci label before creating the issue, or falls back to a create without --label', () => {
    const run = filing.run ?? '';
    const labelAt = run.indexOf('gh label create ci');
    const createAt = run.indexOf('gh issue create');
    const createsLabelFirst = labelAt >= 0 && labelAt < createAt;
    const unlabeledCreate = run
      .replace(/\\\n/g, ' ')
      .split('\n')
      .some((l) => l.includes('gh issue create') && !l.includes('--label'));
    expect(createsLabelFirst || unlabeledCreate).toBe(true);
  });

  it('issue lookup matches the exact title and is not filtered by --label ci', () => {
    const run = (filing.run ?? '').replace(/\\\n/g, ' ');
    const list = run.split('\n').find((l) => l.includes('gh issue list'));
    expect(list).toBeDefined();
    expect(list).not.toContain('--label');
    expect(run).toContain('select(.title == \\"$title\\")');
  });

  it("filing and fail steps are both gated on steps.integration.outcome == 'failure' and the suite step keeps continue-on-error", () => {
    expect(suite?.['continue-on-error']).toBe(true);
    expect(filing.if).toContain(OUTCOME_FAILED);
    expect(filing.if).not.toContain('always()');
    expect(failStep.if).toContain(OUTCOME_FAILED);
  });
});
