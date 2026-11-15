import { checkInfraParkMessage, triageLaneFailures } from '../checkers/triage.js';
import type { EventKind } from '../events/kinds.js';
import type { CheckSummary } from '../types/index.js';

type TriageLog = (type: EventKind, msg: string) => void;

function describeTriage(failures: ReturnType<typeof triageLaneFailures>): string {
  return failures
    .map(({ checker, triage }) => `${checker}=${triage.class === 'infra' ? `infra/${triage.kind}` : triage.class}`)
    .join(', ');
}

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
