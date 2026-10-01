import type { EventKind, FactoryEvent } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { type DashboardState, initialDashboard, reduceDashboard } from '../dashboard.js';
import { Dashboard, laneCountsLine } from './Dashboard.js';

afterEach(cleanup);

function ev(type: EventKind, issue: string, msg: string, ts = '2026-01-01T00:00:00.000Z'): FactoryEvent {
  return { ts, type, issue, msg };
}

function stateFor(events: FactoryEvent[]): DashboardState {
  return events.reduce(reduceDashboard, initialDashboard());
}

function laned(type: EventKind, issue: string, lane: string): FactoryEvent {
  return { ...ev(type, issue, type), lane };
}

const NOW = Date.parse('2026-01-01T00:00:05.000Z');

describe('Dashboard', () => {
  it('renders the stale-lanes footer when lanes were hidden (#1369)', () => {
    const state = initialDashboard();
    const { lastFrame } = render(<Dashboard state={state} selectedIndex={0} now={Date.now()} staleCount={2} />);
    expect(lastFrame()).toContain('(2 stale lanes hidden — no activity for 15m; run factory doctor --reconcile)');
    expect(render(<Dashboard state={state} selectedIndex={0} now={Date.now()} />).lastFrame()).not.toContain(
      'stale lane',
    );
  });

  it('shows the waiting message when there are no lanes', () => {
    const { lastFrame } = render(<Dashboard state={initialDashboard()} selectedIndex={0} now={NOW} />);
    expect(lastFrame()).toContain('idle — no active claims');
  });

  it('renders one row per lane and a lane count in the header', () => {
    const state = stateFor([
      ev('plan', '296', 'Starting plan phase'),
      ev('plan', '301', 'Starting plan phase'),
      ev('plan', '305', 'Starting plan phase'),
    ]);
    const { lastFrame } = render(<Dashboard state={state} selectedIndex={0} now={NOW} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 lane · 3 issues');
    expect(frame).toContain('#305');
    expect(frame).not.toContain('#296');
  });

  it('renders two rows for two lanes', () => {
    const state = stateFor([laned('plan', '10', 'prefix'), laned('plan', '11', 'docs')]);
    const frame = render(<Dashboard state={state} selectedIndex={0} now={NOW} />).lastFrame() ?? '';
    expect(frame).toContain('2 lanes');
    expect(frame).toContain('prefix');
    expect(frame).toContain('docs');
  });

  it('counts one lane on its fifth issue as 1 lane (#1736)', () => {
    const events = ['1706', '1707', '1708', '1709'].flatMap((n) => [
      laned('plan', n, 'prefix'),
      laned('merged', n, 'prefix'),
    ]);
    const state = stateFor([...events, laned('plan', '1710', 'prefix')]);
    const frame = render(<Dashboard state={state} selectedIndex={0} now={NOW} />).lastFrame() ?? '';
    expect(frame).toContain('1 lane · 5 issues');
    expect(frame).not.toContain('5 lanes');
    expect(frame).not.toContain('lane(s)');
  });

  it('counts two lanes with one issue each as 2 lanes (#1736)', () => {
    const state = stateFor([laned('plan', '1', 'prefix'), laned('plan', '2', 'docs')]);
    const frame = render(<Dashboard state={state} selectedIndex={0} now={NOW} />).lastFrame() ?? '';
    expect(frame).toContain('2 lanes');
    expect(frame).not.toContain('issues');
  });

  it('counts a single un-laned issue as 1 lane (#1736)', () => {
    const state = stateFor([ev('plan', '1', 'Starting plan phase')]);
    const frame = render(<Dashboard state={state} selectedIndex={0} now={NOW} />).lastFrame() ?? '';
    expect(frame).toContain('1 lane');
    expect(frame).not.toContain('lanes');
    expect(frame).not.toContain('issue');
  });

  it('laneCountsLine formats idle and multi-issue lanes (#1736)', () => {
    expect(laneCountsLine(initialDashboard())).toBe('0 lanes');
    expect(laneCountsLine(stateFor([laned('plan', '1', 'a'), laned('plan', '2', 'a')]))).toBe('1 lane · 2 issues');
  });

  it('includes the repo in the header when provided, omits it otherwise', () => {
    const state = stateFor([ev('plan', '296', 'Starting plan phase')]);
    const withRepo = render(<Dashboard state={state} selectedIndex={0} now={NOW} repo="on-par/software-factory" />);
    expect(withRepo.lastFrame()).toContain('on-par/software-factory');

    const withoutRepo = render(<Dashboard state={state} selectedIndex={0} now={NOW} />);
    expect(withoutRepo.lastFrame()).not.toContain('undefined');
  });

  it('shows the navigation footer hint', () => {
    const state = stateFor([ev('plan', '296', 'Starting plan phase')]);
    const { lastFrame } = render(<Dashboard state={state} selectedIndex={0} now={NOW} />);
    expect(lastFrame()).toContain('↑/↓ select · ⏎ open lane · q quit');
  });

  it('shows the StopBanner only when a stopReason is set', () => {
    const state = stateFor([ev('plan', '296', 'Starting plan phase')]);
    const stopped = render(<Dashboard state={state} selectedIndex={0} now={NOW} stopReason="STOP flag present" />);
    expect(stopped.lastFrame()).toContain('FACTORY STOPPED');
    expect(stopped.lastFrame()).toContain('STOP flag present');

    const running = render(<Dashboard state={state} selectedIndex={0} now={NOW} />);
    expect(running.lastFrame()).not.toContain('FACTORY STOPPED');
  });
});
