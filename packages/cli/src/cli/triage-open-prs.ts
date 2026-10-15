// triage-open-prs.ts: drops issues that already own an open factory PR from the triage queue (#2981).
import {
  dropQueuedIssues,
  logEvent,
  normalizeTriageQueue,
  parseOpenPrIssues,
  resolveBranchPrefix,
  shellEscape,
} from '@on-par/factory-core/internal';

export type TriageExec = (cmd: string) => Promise<{ stdout: string }>;

/** The queue.proposed comment naming issues skipped for an open PR (#2982); '' when none were. */
export function skippedIssuesComment(dropped: readonly number[]): string {
  if (dropped.length === 0) return '';
  return `# Skipped (a PR is open): ${dropped.map((n) => `#${n}`).join(', ')}\n`;
}

/** Normalizes the model output, then removes entries for issues with an open `<prefix>/<n>-…` PR.
 *  When entries survive, a `# Skipped (a PR is open): …` comment line naming the dropped issues leads the queue.
 *  A failing or malformed `gh pr list` leaves the queue unfiltered. Returns '' when nothing survives. */
export async function proposeTriageQueue(
  output: string,
  ghRepo: string,
  eventsPath: string,
  exec: TriageExec,
): Promise<string> {
  const normalized = normalizeTriageQueue(output);
  if (!normalized) return normalized;
  let prJson: string;
  try {
    const { stdout } = await exec(
      `gh pr list --repo ${shellEscape(ghRepo)} --state open --limit 200 --json headRefName`,
    );
    prJson = stdout || '[]';
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    logEvent(eventsPath, 'warn', '-', `triage could not list open PRs, not filtering: ${detail}`);
    return normalized;
  }
  const open = parseOpenPrIssues(prJson, resolveBranchPrefix());
  if (open === null) {
    logEvent(eventsPath, 'warn', '-', 'triage could not list open PRs, not filtering: malformed gh pr list output');
    return normalized;
  }
  const { queue, dropped } = dropQueuedIssues(normalized, open);
  if (dropped.length > 0) {
    const nums = dropped.map((n) => `#${n}`).join(', ');
    logEvent(eventsPath, 'triage', '-', `Dropped issue(s) with an open factory PR: ${nums}`);
  }
  return queue ? skippedIssuesComment(dropped) + queue : queue;
}
