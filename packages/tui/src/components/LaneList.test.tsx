import type { EventKind, FactoryEvent } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { initialDashboard, lanesOf, reduceDashboard } from '../dashboard.js';
import { LaneList, summarizeLane } from './LaneList.js';

afterEach(cleanup);

function ev(type: EventKind, issue: string, lane: string, ts = '2026-01-01T00:00:00.000Z'): FactoryEvent {
  return { ts, type, issue, msg: type, lane };
}

const stateFor = (events: FactoryEvent[]) => events.reduce(reduceDashboard, initialDashboard());
const NOW = Date.parse('2026-01-01T00:01:00.000Z');

describe('summarizeLane', () => {
  it('picks the running issue over earlier merged ones and counts buckets', () => {
    const state = stateFor([
      ev('plan', '1', 'a'),
      ev('merged', '1', 'a'),
      ev('plan', '2', 'a', '2026-01-01T00:00:10.000Z'),
      ev('merged', '2', 'a', '2026-01-01T00:00:11.000Z'),
      ev('plan', '3', 'a', '2026-01-01T00:00:20.000Z'),
    ]);
    const s = summarizeLane(lanesOf(state)[0], NOW);
    expect(s.current.issue).toBe('3');
    expect(s.merged).toBe(2);
    expect(s.running).toBe(1);
    expect(s.total).toBe(3);
    expect(s.ageMs).toBe(60_000);
  });

  it('falls back to the last issue when everything is terminal', () => {
    const state = stateFor([
      ev('plan', '1', 'a'),
      ev('merged', '1', 'a'),
      ev('plan', '2', 'a'),
      ev('merged', '2', 'a'),
    ]);
    expect(summarizeLane(lanesOf(state)[0], NOW).current.issue).toBe('2');
  });
});

describe('LaneList', () => {
  it('renders one row per lane with the selection marker', () => {
    const state = stateFor([ev('plan', '1', 'prefix'), ev('plan', '2', 'prefix'), ev('plan', '3', 'docs')]);
    const frame =
      render(<LaneList groups={lanesOf(state)} selectedIndex={1} now={NOW} state={state} />).lastFrame() ?? '';
    const rows = frame.split('\n').filter((l) => /prefix|docs/.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('❯');
    expect(rows[0]).toContain('#2');
    expect(rows[0]).toContain('2▶');
  });
});
