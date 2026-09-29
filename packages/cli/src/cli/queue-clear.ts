// packages/cli/src/cli/queue-clear.ts — `factory queue clear` preview (#1693). Read-only: never changes a label.

import type { QueueClearPreview } from '@on-par/factory-core/internal';

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

export async function runQueueClear(deps: {
  previewClear: () => Promise<QueueClearPreview>;
  dryRun?: boolean;
  yes?: boolean;
}): Promise<{ report: string; exitCode: 0 | 1 | 2; message?: string }> {
  const preview = await deps.previewClear();
  if (preview.entries.length === 0) {
    return { report: 'queue is already empty — no open factory:queued issues', exitCode: 0 };
  }
  const body = formatQueueClearPreview(preview);
  if (deps.dryRun) {
    return { report: `dry run — queue clear preview\n${body}\nno GitHub labels changed`, exitCode: 0 };
  }
  const report = `queue clear preview\n${body}`;
  if (!deps.yes) {
    return {
      report,
      exitCode: 2,
      message: 'factory: queue clear needs --yes to proceed (or --dry-run to preview); no GitHub labels changed',
    };
  }
  return {
    report,
    exitCode: 1,
    message: 'factory: queue clear --yes is not implemented yet (#1674); no GitHub labels changed',
  };
}
