import { describe, expect, it } from 'vitest';
import { formatCostSummary, formatIssueCostReport } from './cost-report.js';

const entry = (model: string, issue: string, cachedRateMissing?: boolean) => ({
  ts: '',
  issue,
  task: 'build',
  model,
  inputTokens: 1,
  outputTokens: 1,
  cost: 1,
  ...(cachedRateMissing === undefined ? {} : { cachedRateMissing }),
});

describe('cost report cached rate counts', () => {
  it('marks flagged rows and reports counts in issue scope', () => {
    const lines = formatIssueCostReport([entry('a', '1', true), entry('a', '1', false), entry('b', '1', false)], '1');
    expect(lines.join('\n')).toContain('(cached at full input rate)');
    expect(lines).toContain('  a: cachedRateMissing=1');
    expect(lines).toContain('  cachedRateMissing: 1');
  });

  it('counts only stored flags in model and total summaries', () => {
    const lines = formatCostSummary([entry('a', '1', true), entry('a', '1', false), entry('legacy', '1')]);
    expect(lines).toContain('  a: 2 tasks, $2.0000 cachedRateMissing=1 (cached at full input rate)');
    expect(lines).toContain('  legacy: 1 tasks, $1.0000 cachedRateMissing=0');
    expect(lines).toContain('  cachedRateMissing: 1');
  });
});
