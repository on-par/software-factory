import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { TabBar } from './TabBar.js';

afterEach(cleanup);

describe('TabBar', () => {
  it('shows all five tab names', () => {
    const { lastFrame } = render(<TabBar active="dashboard" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Active');
    expect(frame).toContain('Queue');
    expect(frame).toContain('Costs');
    expect(frame).toContain('Log');
    expect(frame).toContain('Health');
  });

  it('marks only the active tab with brackets', () => {
    const frame = render(<TabBar active="queue" />).lastFrame() ?? '';
    expect(frame).toContain('[2 Queue]');
    expect(frame).not.toContain('[1 Active]');
    expect(frame).not.toContain('[3 Costs]');
    expect(frame).not.toContain('[4 Log]');
    expect(frame).not.toContain('[5 Health]');
  });

  it('moves the bracket marker as the active tab changes', () => {
    expect(render(<TabBar active="dashboard" />).lastFrame()).toContain('[1 Active]');
    expect(render(<TabBar active="log" />).lastFrame()).toContain('[4 Log]');
    expect(render(<TabBar active="health" />).lastFrame()).toContain('[5 Health]');
  });
});
