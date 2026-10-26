// triage-finish-first.ts: soft finish-before-start preference for open decomposed parents in the triage queue (#3109).
import {
  logEvent,
  type parseTriageCandidates,
  parseParentReference,
  preferStartedParents,
  shellEscape,
  triageParentCoverage,
} from '@on-par/factory-core/internal';

import type { TriageExec } from './triage-open-prs.js';

type TriageCandidate = ReturnType<typeof parseTriageCandidates>[number];
type TriageClosedIssue = Parameters<typeof triageParentCoverage>[1][number];

function warn(eventsPath: string, detail: string): void {
  logEvent(
    eventsPath,
    'warn',
    '-',
    `triage could not list closed issues, no finish-before-start preference: ${detail}`,
  );
}

/** Moves children of a started open parent ahead of children of a new parent, never across a
 *  `factory:order` pin, and logs one `triage` event per move. A failing or malformed closed-issue
 *  fetch leaves the queue unchanged. */
export async function applyFinishBeforeStart(
  queue: string,
  candidates: readonly TriageCandidate[],
  ghRepo: string,
  eventsPath: string,
  exec: TriageExec,
): Promise<string> {
  if (queue === '') return queue;
  if (!candidates.some((c) => parseParentReference(c.body) !== null)) return queue;
  let parsed: unknown;
  try {
    const { stdout } = await exec(
      `gh issue list --repo ${shellEscape(ghRepo)} --state closed --limit 200 --json number,body`,
    );
    parsed = JSON.parse(stdout || '[]');
  } catch (err: unknown) {
    warn(eventsPath, err instanceof Error ? err.message : String(err));
    return queue;
  }
  if (!Array.isArray(parsed)) {
    warn(eventsPath, 'malformed gh issue list output');
    return queue;
  }
  const closed: TriageClosedIssue[] = [];
  for (const row of parsed) {
    if (row && typeof row.number === 'number') {
      closed.push({ number: row.number, body: typeof row.body === 'string' ? row.body : '' });
    }
  }
  const result = preferStartedParents(queue, candidates, triageParentCoverage(candidates, closed));
  for (const reason of result.reasons) logEvent(eventsPath, 'triage', '-', reason);
  return result.queue;
}
