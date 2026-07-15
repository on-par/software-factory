import type { FactoryEvent } from '@on-par/factory-core';

export const PHASES = ['PLAN', 'BUILD', 'CHECK', 'SHIP'] as const;
export type PhaseName = (typeof PHASES)[number];
export type PhaseStatus = 'pending' | 'active' | 'done';

export interface RunState {
  issue?: string;
  activePhase?: PhaseName;
  phaseStatus: Record<PhaseName, PhaseStatus>;
  phaseStartedAt?: string;
  model?: string;
  route?: string;
  done: boolean;
  feed: FactoryEvent[];
}

export function initialState(): RunState {
  return {
    phaseStatus: { PLAN: 'pending', BUILD: 'pending', CHECK: 'pending', SHIP: 'pending' },
    done: false,
    feed: [],
  };
}

const PHASE_BY_EVENT_TYPE: Record<string, PhaseName> = {
  plan: 'PLAN',
  build: 'BUILD',
  check: 'CHECK',
  rework: 'CHECK',
  ship: 'SHIP',
};

const MODEL_TRYING_RE = /Trying (\S+) for/;
const MODEL_COMPLETE_RE = /complete with model (\S+?),?\s/;
const MODEL_TRAILING_RE = /with model (\S+)$/;
const ROUTE_RE = /route: (\S+?)\)?$/;

const FAILOVER_MSG_RE = /failing over|failed \(|Rate limited|timed out/;
const FAILOVER_TYPES = new Set(['warn', 'escalate', 'fail']);

export function isFailoverEvent(e: FactoryEvent): boolean {
  if (e.type === 'router' && FAILOVER_MSG_RE.test(e.msg)) return true;
  return FAILOVER_TYPES.has(e.type);
}

function extractModel(e: FactoryEvent): string | undefined {
  if (e.type === 'router') {
    return e.msg.match(MODEL_TRYING_RE)?.[1];
  }
  if (e.type === 'plan' || e.type === 'build') {
    return e.msg.match(MODEL_COMPLETE_RE)?.[1] ?? e.msg.match(MODEL_TRAILING_RE)?.[1];
  }
  return undefined;
}

function extractRoute(e: FactoryEvent): string | undefined {
  if (e.type === 'plan' || e.type === 'build') {
    return e.msg.match(ROUTE_RE)?.[1];
  }
  return undefined;
}

export function reduceEvent(state: RunState, e: FactoryEvent): RunState {
  const feed = [...state.feed, e].slice(-10);

  if (e.type === 'ready') {
    return {
      ...state,
      phaseStatus: { PLAN: 'done', BUILD: 'done', CHECK: 'done', SHIP: 'done' },
      activePhase: undefined,
      done: true,
      feed,
    };
  }

  const phase = PHASE_BY_EVENT_TYPE[e.type];
  const model = extractModel(e) ?? state.model;
  const route = extractRoute(e) ?? state.route;

  if (!phase) {
    return { ...state, model, route, feed, issue: e.issue ?? state.issue };
  }

  const phaseChanged = state.activePhase !== phase;
  const activeIndex = PHASES.indexOf(phase);
  const phaseStatus = Object.fromEntries(
    PHASES.map((p, i) => [p, i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending']),
  ) as Record<PhaseName, PhaseStatus>;

  return {
    ...state,
    issue: e.issue,
    activePhase: phase,
    phaseStatus,
    phaseStartedAt: phaseChanged ? e.ts : state.phaseStartedAt,
    model,
    route,
    done: false,
    feed,
  };
}
