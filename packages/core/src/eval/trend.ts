import type { EvalSummary } from './types.js';

export interface HistoryRecord {
  date: string;
  passRate: number;
  routeAccuracy: number;
  meanRubric: number | null;
  cost: number;
  run?: string;
}

export function summaryToHistoryRecord(summary: EvalSummary, date: string, runUrl?: string): HistoryRecord {
  const rubricScores = summary.results.map((result) => result.rubricScore).filter((score) => score !== undefined);

  return {
    date,
    passRate: summary.passRate,
    routeAccuracy: summary.routeAccuracy,
    meanRubric: rubricScores.length
      ? rubricScores.reduce((total, score) => total + score, 0) / rubricScores.length
      : null,
    cost: summary.totalCostEstimate,
    ...(runUrl ? { run: runUrl } : {}),
  };
}

export function parseHistory(jsonl: string): HistoryRecord[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as HistoryRecord);
}

export function appendHistoryLine(existing: string, record: HistoryRecord): string {
  const line = `${JSON.stringify(record)}\n`;
  if (!existing.trim()) return line;
  return `${existing.endsWith('\n') ? existing : `${existing}\n`}${line}`;
}

export function renderTrend(records: HistoryRecord[], opts: { window?: number; minForTrend?: number } = {}): string {
  const window = opts.window ?? 14;
  const minForTrend = opts.minForTrend ?? 7;

  const lines = ['## Eval trend', ''];

  if (records.length === 0) {
    lines.push('No eval history yet.');
    return `${lines.join('\n')}\n`;
  }

  const visible = records.slice(-window);
  lines.push(
    '| date | pass rate | route acc | mean rubric | cost |',
    '| --- | --- | --- | --- | --- |',
    ...visible.map((record) => {
      const columns = [
        record.date,
        formatPercent(record.passRate),
        formatPercent(record.routeAccuracy),
        formatRubric(record.meanRubric),
        formatCost(record.cost),
      ];
      return `| ${columns.join(' | ')} |`;
    }),
  );

  if (records.length < minForTrend) {
    lines.push('', `_Trend visible after ${minForTrend}+ weekly runs (currently ${records.length})._`);
  }

  return `${lines.join('\n')}\n`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatRubric(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}
