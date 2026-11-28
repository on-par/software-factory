import type { EventTraits } from './event-traits.js';

export type CiReworkEventKind = 'ci-rework-no-change' | 'ci-flaky' | 'ci-flaky-rerun-green';

export const CI_REWORK_EVENT_TRAITS: Record<CiReworkEventKind, EventTraits> = {
  'ci-rework-no-change': { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  'ci-flaky': { severity: 'error', isPark: true, isTerminal: true, laneStatus: 'failed' },
  'ci-flaky-rerun-green': { severity: 'warn', isPark: false, isTerminal: false },
};
