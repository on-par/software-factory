import { styleText } from 'node:util';
import { aggregateCosts, formatCostTotal, type CostEntry } from '@on-par/factory-core';

export function formatIssueCostReport(entries: CostEntry[], issue: string): string[] {
  const missing = new Map<string, number>();
  const rows = entries.map((entry) => {
    if (entry.cachedRateMissing === true) missing.set(entry.model, (missing.get(entry.model) ?? 0) + 1);
    const marker = entry.cachedRateMissing === true ? ' (cached at full input rate)' : '';
    const cost = entry.cost === null || entry.cost === undefined ? 'unknown' : `$${entry.cost.toFixed(4)}`;
    const failover = entry.failoverReason ? ` [failover: ${entry.failoverReason}]` : '';
    return `  ${entry.task} ${entry.model}${marker} ${cost}${failover}`;
  });
  const total = aggregateCosts(entries).total;
  return [
    styleText('bold', `== Costs for issue ${issue} ==`),
    ...rows,
    ...[...missing].map(([model, count]) => `  ${model}: cachedRateMissing=${count}`),
    '  ---',
    `  cachedRateMissing: ${[...missing.values()].reduce((sum, count) => sum + count, 0)}`,
    `  Total: ${formatCostTotal(total.cost, total.unpricedCount)}`,
  ];
}

export function formatCostSummary(entries: CostEntry[]): string[] {
  const models = new Map<
    string,
    {
      tasks: number;
      priced: number;
      pricedCount: number;
      unpriced: number;
      failovers: number;
      cachedRateMissing: number;
    }
  >();
  for (const entry of entries) {
    const row = models.get(entry.model) ?? {
      tasks: 0,
      priced: 0,
      pricedCount: 0,
      unpriced: 0,
      failovers: 0,
      cachedRateMissing: 0,
    };
    row.tasks++;
    if (entry.unpriced === true || entry.cost === null || entry.cost === undefined) row.unpriced++;
    else {
      row.priced += entry.cost;
      row.pricedCount++;
    }
    if (entry.failoverReason) row.failovers++;
    if (entry.cachedRateMissing === true) row.cachedRateMissing++;
    models.set(entry.model, row);
  }
  const lines = [styleText('bold', '== Cost Summary ==')];
  for (const [model, row] of models) {
    const failovers = row.failovers > 0 ? ` (${row.failovers} failover${row.failovers === 1 ? '' : 's'})` : '';
    const cost = formatCostTotal(row.pricedCount === 0 && row.unpriced > 0 ? null : row.priced, row.unpriced);
    const cached =
      row.cachedRateMissing > 0
        ? ` cachedRateMissing=${row.cachedRateMissing} (cached at full input rate)`
        : ' cachedRateMissing=0';
    lines.push(`  ${model}: ${row.tasks} tasks, ${cost}${failovers}${cached}`);
  }
  const total = aggregateCosts(entries).total;
  lines.push(
    '  ---',
    `  cachedRateMissing: ${[...models.values()].reduce((sum, row) => sum + row.cachedRateMissing, 0)}`,
  );
  lines.push(`  Total: ${formatCostTotal(total.cost, total.unpricedCount)}`);
  return lines;
}
