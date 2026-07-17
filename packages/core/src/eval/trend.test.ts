import { describe, expect, it } from 'vitest';

import { appendHistoryLine, type HistoryRecord, parseHistory, renderTrend, summaryToHistoryRecord } from './trend.js';
import { type CaseResult, type EvalSummary, isRouteAsserted } from './types.js';

function caseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    id: 'case',
    pass: true,
    route: 'codex',
    expectedRoute: 'codex',
    routeCorrect: true,
    checks: [],
    judgeSkipped: true,
    model: 'stub-model',
    latencyMs: 10,
    costEstimate: 0,
    ...overrides,
  };
}

function summaryOf(results: CaseResult[], totalCostEstimate = 0): EvalSummary {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const routeAsserted = results.filter((r) => isRouteAsserted(r.expectedRoute)).length;
  const routeCorrect = results.filter((r) => isRouteAsserted(r.expectedRoute) && r.routeCorrect).length;
  return {
    results,
    total,
    passed,
    failed: total - passed,
    passRate: total ? passed / total : 0,
    routeAsserted,
    routeAccuracy: routeAsserted ? routeCorrect / routeAsserted : 1,
    totalCostEstimate,
    totalLatencyMs: 0,
  };
}

function historyRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    date: '2026-07-01',
    passRate: 1,
    routeAccuracy: 1,
    meanRubric: 8,
    cost: 0.1234,
    ...overrides,
  };
}

describe('summaryToHistoryRecord', () => {
  it('averages defined rubric scores and copies summary metrics', () => {
    const summary = summaryOf(
      [
        caseResult({ id: 'a', rubricScore: 8 }),
        caseResult({ id: 'b', rubricScore: undefined, routeCorrect: false }),
        caseResult({ id: 'c', rubricScore: 9.5, pass: false }),
      ],
      0.4321,
    );

    const record = summaryToHistoryRecord(summary, '2026-07-11', 'https://example.test/run');

    expect(record).toEqual({
      date: '2026-07-11',
      passRate: 2 / 3,
      routeAccuracy: 2 / 3,
      meanRubric: 8.75,
      cost: 0.4321,
      run: 'https://example.test/run',
    });
  });

  it('sets meanRubric to null when no rubric scores are present and omits run without a URL', () => {
    const summary = summaryOf([caseResult({ id: 'a' })], 0.01);

    const record = summaryToHistoryRecord(summary, '2026-07-11');

    expect(record.meanRubric).toBeNull();
    expect(record).not.toHaveProperty('run');
    expect(record.cost).toBe(0.01);
  });
});

describe('appendHistoryLine', () => {
  it('writes a single line for empty existing content without a leading newline', () => {
    const record = historyRecord();

    const updated = appendHistoryLine('', record);

    expect(updated).toBe(`${JSON.stringify(record)}\n`);
  });

  it('inserts a newline when existing content has no trailing newline', () => {
    const first = historyRecord({ date: '2026-07-01' });
    const second = historyRecord({ date: '2026-07-02' });

    const updated = appendHistoryLine(JSON.stringify(first), second);

    expect(updated).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    expect(parseHistory(updated)).toEqual([first, second]);
  });

  it('round-trips existing whitespace-only content through parseHistory', () => {
    const record = historyRecord();

    const updated = appendHistoryLine('\n  \n', record);

    expect(parseHistory(updated)).toEqual([record]);
  });
});

describe('parseHistory', () => {
  it('ignores blank lines and parses records in order', () => {
    const first = historyRecord({ date: '2026-07-01' });
    const second = historyRecord({ date: '2026-07-02' });

    const records = parseHistory(`\n${JSON.stringify(first)}\n  \n${JSON.stringify(second)}\n`);

    expect(records).toEqual([first, second]);
  });
});

describe('renderTrend', () => {
  it('renders an empty-history notice', () => {
    const rendered = renderTrend([]);

    expect(rendered).toContain('## Eval trend');
    expect(rendered).toContain('No eval history yet.');
  });

  it('shows the warmup note before seven records', () => {
    const rendered = renderTrend([historyRecord()]);

    expect(rendered).toContain('_Trend visible after 7+ weekly runs (currently 1)._');
  });

  it('omits the warmup note once seven records are present', () => {
    const records = Array.from({ length: 7 }, (_, index) =>
      historyRecord({ date: `2026-07-${String(index + 1).padStart(2, '0')}` }),
    );

    const rendered = renderTrend(records);

    expect(rendered).toContain('| date | pass rate | route acc | mean rubric | cost |');
    expect(rendered).not.toContain('Trend visible after');
  });

  it('respects the window by rendering only the most recent rows oldest to newest', () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      historyRecord({ date: `2026-07-${String(index + 1).padStart(2, '0')}` }),
    );

    const rendered = renderTrend(records, { window: 2, minForTrend: 1 });

    expect(rendered).not.toContain('2026-07-03');
    expect(rendered).toContain('| 2026-07-04 |');
    expect(rendered).toContain('| 2026-07-05 |');
    expect(rendered.indexOf('2026-07-04')).toBeLessThan(rendered.indexOf('2026-07-05'));
  });

  it('formats percentages, cost, and null rubric values', () => {
    const rendered = renderTrend(
      [
        historyRecord({
          passRate: 1,
          routeAccuracy: 0.875,
          meanRubric: null,
          cost: 0.5,
        }),
      ],
      { minForTrend: 1 },
    );

    expect(rendered).toContain('| 2026-07-01 | 100% | 88% | — | $0.5000 |');
  });
});
