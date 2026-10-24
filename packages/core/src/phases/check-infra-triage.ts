import { checkInfraParkMessage, triageLaneFailures } from '../checkers/triage.js';
import type { EventKind } from '../events/kinds.js';
import type { CheckSummary } from '../types/index.js';

type TriageLog = (type: EventKind, msg: string) => void;

function describeTriage(failures: ReturnType<typeof triageLaneFailures>): string {
  return failures
    .map(({ checker, triage }) => `${checker}=${triage.class === 'infra' ? `infra/${triage.kind}` : triage.class}`)
    .join(', ');
}

/**
 * Infra triage (#3371). When every lane-owned FAIL (`laneOwned` drops base-failing checkers) is infrastructure,
 * re-run the checkers once with no model call. Returns the summary to carry on with, plus `infra` (the
 * park message) when a network or missing-tool failure repeated. A timeout-only repeat or any code
 * failure leaves `infra` unset so the caller falls through to rework with the re-run summary.
 */
export async function infraTriage(
  summary: CheckSummary,
  laneOwned: (s: CheckSummary) => CheckSummary,
  rerun: () => Promise<CheckSummary>,
  log: TriageLog,
  logFailures: (s: CheckSummary) => void,
): Promise<{ summary: CheckSummary; infra?: string }> {
  const laneFailures = triageLaneFailures(laneOwned(summary));
  if (laneFailures.length === 0 || !laneFailures.every((f) => f.triage.class === 'infra')) return { summary };
  log('check_triage', `infra-only failures (${describeTriage(laneFailures)}) — re-running checkers once, no rework`);
  const next = await rerun();
  const repeat = triageLaneFailures(laneOwned(next));
  const parkOn = repeat.find((f) => f.triage.class === 'infra' && f.triage.kind !== 'timeout');
  if (repeat.every((f) => f.triage.class === 'infra') && repeat.length > 0 && parkOn?.triage.class === 'infra') {
    const infra = checkInfraParkMessage(parkOn.checker, parkOn.triage.line);
    log('check', `${infra} — parking check-infra`);
    logFailures(next);
    return { summary: next, infra };
  }
  log('check', repeat.length === 0 ? 'triage re-run passed' : 'triage re-run still failing — continuing to rework');
  return { summary: next };
}
