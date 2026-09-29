// packages/cli/src/cli/queue-clear.ts — `factory queue clear`: preview (#1693) and `--yes` clear (#1694).

import type { QueueClearPreview, QueueClearResult } from '@on-par/factory-core/internal';

export function formatQueueClearPreview(preview: QueueClearPreview): string {
  const lines = preview.entries.map((entry) => {
    const lane = entry.lanes.length > 0 ? entry.lanes.join(',') : '(none)';
    const reason = entry.action === 'would-skip' && entry.reason !== undefined ? ` — ${entry.reason}` : '';
    const title = entry.title ? ` — ${entry.title}` : '';
    return `  #${entry.issue} [lane ${lane}] ${entry.action}${reason}${title}`;
  });
  lines.push(
    `${preview.entries.length} queued issue(s): ${preview.wouldClear} would-clear, ${preview.wouldSkip} would-skip`,
  );
  return lines.join('\n');
}

export function formatQueueClearResult(result: QueueClearResult): string {
  const lines = result.entries.map((entry) => {
    const lane = entry.lanes.length > 0 ? entry.lanes.join(',') : '(none)';
    const reason = entry.reason !== undefined ? ` — ${entry.reason}` : '';
    const title = entry.title ? ` — ${entry.title}` : '';
    return `  #${entry.issue} [lane ${lane}] ${entry.outcome}${reason}${title}`;
  });
  const failed = result.failed > 0 ? `, ${result.failed} failed` : '';
  lines.push(`${result.entries.length} queued issue(s): ${result.cleared} cleared, ${result.skipped} skipped${failed}`);
  return lines.join('\n');
}

const EMPTY_QUEUE_REPORT = 'queue is already empty — no open factory:queued issues';

export async function runQueueClear(deps: {
  previewClear: () => Promise<QueueClearPreview>;
  clear: () => Promise<QueueClearResult>;
  dryRun?: boolean;
  yes?: boolean;
}): Promise<{ report: string; exitCode: 0 | 1 | 2; message?: string }> {
  if (deps.yes && !deps.dryRun) {
    const result = await deps.clear();
    if (result.entries.length === 0) return { report: EMPTY_QUEUE_REPORT, exitCode: 0 };
    const report = `queue clear\n${formatQueueClearResult(result)}`;
    if (result.failed > 0) {
      return {
        report,
        exitCode: 1,
        message: `factory: queue clear failed for ${result.failed} issue(s); see the lines above`,
      };
    }
    return { report, exitCode: 0 };
  }
  const preview = await deps.previewClear();
  if (preview.entries.length === 0) {
    return { report: EMPTY_QUEUE_REPORT, exitCode: 0 };
  }
  const body = formatQueueClearPreview(preview);
  if (deps.dryRun) {
    return { report: `dry run — queue clear preview\n${body}\nno GitHub labels changed`, exitCode: 0 };
  }
  return {
    report: `queue clear preview\n${body}`,
    exitCode: 2,
    message: 'factory: queue clear needs --yes to proceed (or --dry-run to preview); no GitHub labels changed',
  };
}
