// triage-open-prs.ts: drops issues that already own an open factory PR from the triage queue (#2981).
import { logEvent, normalizeTriageQueue, resolveBranchPrefix, shellEscape } from '@on-par/factory-core/internal';

export type TriageExec = (cmd: string) => Promise<{ stdout: string }>;

/** Normalizes the model output, then removes entries for issues with an open `<prefix>/<n>-…` PR.
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
  const queue = normalizeTriageQueue(output, prJson, resolveBranchPrefix());
  const kept = new Set(queue.split('\n'));
  const dropped = normalized.split('\n').filter((l) => l && !l.startsWith('#') && !kept.has(l));
  if (dropped.length > 0) {
    const nums = dropped.map((l) => `#${l.split(' ')[1]}`).join(', ');
    logEvent(eventsPath, 'triage', '-', `Dropped issue(s) with an open factory PR: ${nums}`);
  }
  return queue;
}
