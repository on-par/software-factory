import {
  buildDefectRateSeries,
  buildDriftFlagSeries,
  buildPhaseBreakdownSeries,
  buildReworkSplitSeries,
  parseKpiHistory,
  type TrendPoint,
} from './kpiTrend.js';

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatMs(value: number): string {
  return `${Math.round(value)}ms`;
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function Sparkline({
  label,
  points,
  formatValue,
}: {
  label: string;
  points: TrendPoint[];
  formatValue: (value: number) => string;
}) {
  const values = points.map((point) => point.value).filter((value): value is number => typeof value === 'number');
  const max = values.length > 0 ? Math.max(...values) : 0;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-ink-600">{label}</p>
      {values.length === 0 ? (
        <p className="text-xs text-ink-400">No data</p>
      ) : (
        <div role="img" aria-label={label} className="flex h-6 items-end gap-0.5">
          {points.map((point) => (
            <div
              key={point.date}
              title={
                typeof point.value === 'number' ? `${point.date}: ${formatValue(point.value)}` : `${point.date}: n/a`
              }
              className="w-1.5 rounded-sm bg-blue-500"
              style={{
                height: typeof point.value === 'number' ? `${Math.max(4, (point.value / (max || 1)) * 100)}%` : '2px',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export interface KpiTrendViewProps {
  kpiHistoryJsonl: string;
}

/** Reads kpi-history.jsonl (as persisted by #612, #613, #614) and renders four
 *  read-only time-series views over recent runs: post-merge defect rate, drift
 *  flags, phase-level cost/time breakdown, and collision-vs-checker rework split. */
export function KpiTrendView({ kpiHistoryJsonl }: KpiTrendViewProps) {
  const records = parseKpiHistory(kpiHistoryJsonl);

  if (records.length === 0) {
    return <p className="text-sm text-ink-400">No KPI history yet.</p>;
  }

  const defectRate = buildDefectRateSeries(records);
  const drift = buildDriftFlagSeries(records);
  const phases = buildPhaseBreakdownSeries(records);
  const rework = buildReworkSplitSeries(records);

  return (
    <section aria-label="KPI trends" className="flex flex-col gap-4">
      <Sparkline label="Post-merge defect rate" points={defectRate} formatValue={formatPercent} />
      <Sparkline label="Drift flags" points={drift} formatValue={(value) => (value > 0 ? 'drift' : 'stable')} />

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-ink-600">Phase-level cost/time breakdown</p>
        {phases.map((phase) => (
          <div key={phase.phase} className="flex flex-col gap-1 pl-2">
            <Sparkline label={`${phase.phase} duration`} points={phase.durationMs} formatValue={formatMs} />
            <Sparkline label={`${phase.phase} cost`} points={phase.cost} formatValue={formatCost} />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-ink-600">Collision-vs-checker rework split</p>
        <Sparkline label="Collision-caused rework" points={rework.collision} formatValue={formatPercent} />
        <Sparkline label="Checker-caused rework" points={rework.checker} formatValue={formatPercent} />
      </div>
    </section>
  );
}
