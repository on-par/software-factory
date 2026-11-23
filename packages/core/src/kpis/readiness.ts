import type { EscalateKind, FactoryEvent, ReadinessInfo } from '../types/index.js';

type Verdict = NonNullable<ReadinessInfo['judge']>['verdict'];

export interface ReadinessVerdictKpis {
  readinessVerdicts: { ready: number; withAssumptions: number; notReady: number };
  notReadyParkRate: number;
  lateNotReadyRuns: number;
}

const VERDICT_KEY = {
  ready: 'ready',
  'ready-with-assumptions': 'withAssumptions',
  'not-ready': 'notReady',
} as const satisfies Record<Verdict, keyof ReadinessVerdictKpis['readinessVerdicts']>;

const LATE_ESCALATE_KINDS: ReadonlySet<EscalateKind> = new Set(['missing-info', 'contradiction']);

function isLateEscalate(event: FactoryEvent, verdict: Verdict | undefined): boolean {
  return (
    event.type === 'escalate' &&
    event.phase === 'plan' &&
    event.escalateKind !== undefined &&
    LATE_ESCALATE_KINDS.has(event.escalateKind) &&
    verdict !== undefined &&
    verdict !== 'not-ready'
  );
}

export function computeReadinessVerdictKpis(
  events: FactoryEvent[],
  runs: ReadonlyMap<string, unknown>,
): ReadinessVerdictKpis {
  const verdicts = new Map<string, Verdict>();
  const parked = new Set<string>();
  const late = new Set<string>();
  for (const event of events) {
    if (!runs.has(event.issue)) continue;
    const verdict = event.readiness?.judge?.verdict;
    if (verdict) verdicts.set(event.issue, verdict);
    if (event.type === 'not-ready') parked.add(event.issue);
    if (isLateEscalate(event, verdicts.get(event.issue))) late.add(event.issue);
  }
  const readinessVerdicts = { ready: 0, withAssumptions: 0, notReady: 0 };
  for (const verdict of verdicts.values()) readinessVerdicts[VERDICT_KEY[verdict]]++;
  return {
    readinessVerdicts,
    notReadyParkRate: runs.size === 0 ? 0 : parked.size / runs.size,
    lateNotReadyRuns: late.size,
  };
}
