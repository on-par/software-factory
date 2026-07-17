import type { FactoryEvent } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { type DashboardState, initialDashboard, reduceDashboard } from '../dashboard.js';
import { Dashboard } from './Dashboard.js';

afterEach(cleanup);

function ev(type: string, issue: string, msg: string, ts = '2026-01-01T00:00:00.000Z'): FactoryEvent {
  return { ts, type, issue, msg };
}

function stateFor(events: FactoryEvent[]): DashboardState {
  return events.reduce(reduceDashboard, initialDashboard());
}

const NOW = Date.parse('2026-01-01T00:00:05.000Z');

describe('Dashboard', () => {
  it('shows the waiting message when there are no lanes', () => {
    const { lastFrame } = render(<Dashboard state={initialDashboard()} selectedIndex={0} now={NOW} />);
    expect(lastFrame()).toContain('waiting for factory events');
  });

  it('renders one row per lane and a lane count in the header', () => {
    const state = stateFor([
      ev('plan', '296', 'Starting plan phase'),
      ev('plan', '301', 'Starting plan phase'),
      ev('plan', '305', 'Starting plan phase'),
    ]);
    const { lastFrame } = render(<Dashboard state={state} selectedIndex={0} now={NOW} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('3 lane(s)');
    expect(frame).toContain('#296');
    expect(frame).toContain('#301');
    expect(frame).toContain('#305');
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
    expect(lastFrame()).toContain('↑/↓ select · ⏎ detail · q quit');
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
