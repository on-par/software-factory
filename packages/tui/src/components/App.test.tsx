import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { FactoryEvent } from '@on-par/factory-core';
import { App } from './App.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeFakeFollow() {
  let onEvent: ((e: FactoryEvent) => void) | undefined;
  const stop = vi.fn();
  const follow = vi.fn((_file: string, cb: (e: FactoryEvent) => void) => {
    onEvent = cb;
    return stop;
  });
  return {
    follow,
    stop,
    push: (e: FactoryEvent) => onEvent?.(e),
  };
}

function ev(type: string, msg: string, issue = '192', ts = new Date().toISOString()): FactoryEvent {
  return { ts, type, issue, msg };
}

/** Ink schedules re-renders on a microtask; flush it before reading lastFrame(). */
const flush = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

describe('App', () => {
  it('shows a waiting message before any events arrive', () => {
    const { follow } = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={follow} />);
    expect(lastFrame()).toContain('waiting for factory events');
  });

  it('renders a single lane directly in detail view with no row list', async () => {
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('router', 'Trying claude-sonnet for plan (attempt 1)', '296'));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('#296');
    expect(frame).toContain('PLAN');
    expect(frame).toContain('claude-sonnet');
    expect(frame).not.toContain('lane(s)');
  });

  it('renders independent rows for multiple lanes that update independently', async () => {
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    fake.push(ev('build', 'Starting build phase (route: claude)', '301'));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 lane(s)');
    expect(frame).toContain('#296');
    expect(frame).toContain('#301');
  });

  it('drills into the selected lane on down-arrow then Enter, and Escape returns to the dashboard', async () => {
    const fake = makeFakeFollow();
    const { lastFrame, stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    fake.push(ev('router', 'Trying gpt-5 for plan (attempt 1)', '301'));
    await flush();

    stdin.write('[B'); // down arrow
    await flush();
    stdin.write('\r'); // enter
    await flush();

    const detailFrame = lastFrame() ?? '';
    expect(detailFrame).toContain('#301');
    expect(detailFrame).toContain('gpt-5');
    expect(detailFrame).toContain('esc back · q quit');

    stdin.write(''); // escape
    await flush();

    const dashboardFrame = lastFrame() ?? '';
    expect(dashboardFrame).toContain('2 lane(s)');
  });

  it('stops following when the user presses q from the dashboard or detail view', async () => {
    const fake = makeFakeFollow();
    const { stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    await flush();

    stdin.write('\r'); // enter detail view
    await flush();
    stdin.write('q');
    await flush();

    expect(fake.stop).toHaveBeenCalled();
  });

  it('shows the STOP banner once the poll observes the stop file, without disturbing lane rows', async () => {
    vi.useFakeTimers();
    const fake = makeFakeFollow();
    const pathExists = vi.fn(() => true);
    const { lastFrame } = render(
      <App eventsFile="ignored" follow={fake.follow} stopFile="/repo/.factory/STOP" pathExists={pathExists} />,
    );

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1600);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('FACTORY STOPPED');
    expect(frame).toContain('#296');
    expect(frame).toContain('#301');
  });

  it('shows the STOP banner with the usage cap message when a usage-stop event is observed', async () => {
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '296'));
    fake.push(ev('plan', 'Starting plan phase', '301'));
    fake.push(ev('usage-stop', 'daily usage cap reached', 'usage'));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('FACTORY STOPPED');
    expect(frame).toContain('daily usage cap reached');
  });
});
