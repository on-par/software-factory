import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { FactoryEvent } from '@on-par/factory-core';
import { LogTab } from './LogTab.js';
import { initialLogScroll } from './log-scroll.js';

afterEach(cleanup);

function events(n: number): FactoryEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: `2026-01-01T00:00:0${i}.000Z`,
    type: 'build',
    issue: '1',
    msg: `msg ${i}`,
  }));
}

describe('LogTab', () => {
  it('renders the windowed slice of events', () => {
    const { lastFrame } = render(<LogTab events={events(3)} scroll={initialLogScroll()} height={10} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('msg 0');
    expect(frame).toContain('msg 2');
  });

  it('windows to the newest events when there are more than fit', () => {
    const { lastFrame } = render(<LogTab events={events(10)} scroll={initialLogScroll()} height={3} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('msg 0');
    expect(frame).toContain('msg 9');
  });

  it('shows the follow state and range in the footer', () => {
    const { lastFrame } = render(<LogTab events={events(10)} scroll={initialLogScroll()} height={3} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('follow: on');
    expect(frame).toContain('8-10/10');
  });

  it('shows follow: off and an older range when scrolled up', () => {
    const { lastFrame } = render(<LogTab events={events(10)} scroll={{ follow: false, offset: 5 }} height={3} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('follow: off');
    expect(frame).toContain('3-5/10');
  });
});
