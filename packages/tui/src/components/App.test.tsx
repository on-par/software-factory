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

function ev(type: string, msg: string, ts = new Date().toISOString(), issue = '192'): FactoryEvent {
  return { ts, type, issue, msg };
}

/** Ink schedules re-renders on a microtask; flush it before reading lastFrame(). */
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('App', () => {
  it('shows a waiting message before any events arrive', () => {
    const { follow } = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={follow} />);
    expect(lastFrame()).toContain('waiting for factory events');
  });

  it('renders the active phase with model/route once PLAN starts', async () => {
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase'));
    fake.push(ev('router', 'Trying claude-sonnet for plan (attempt 1)'));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('PLAN');
    expect(frame).toContain('claude-sonnet');
    expect(frame).toContain('BUILD');
  });

  it('marks PLAN done once BUILD starts', async () => {
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase'));
    fake.push(ev('plan', 'Plan complete with model claude-sonnet, route: claude'));
    fake.push(ev('build', 'Starting build phase (route: claude)'));
    await flush();

    expect(lastFrame() ?? '').toContain('✔ PLAN');
  });

  it('renders a failover event in the feed', async () => {
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase'));
    fake.push(ev('router', 'claude-sonnet failed (rate_limit) on plan'));
    await flush();

    expect(lastFrame() ?? '').toContain('claude-sonnet failed (rate_limit) on plan');
  });

  it('updates the elapsed timer as time passes', async () => {
    vi.useFakeTimers();
    const fake = makeFakeFollow();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);

    fake.push(ev('plan', 'Starting plan phase', '2026-01-01T00:00:00.000Z'));
    await vi.advanceTimersByTimeAsync(0);
    const before = lastFrame();

    await vi.advanceTimersByTimeAsync(1100);

    const after = lastFrame();
    expect(after).not.toBe(before);
  });

  it('stops following when the user presses q', async () => {
    const fake = makeFakeFollow();
    const { stdin } = render(<App eventsFile="ignored" follow={fake.follow} />);

    stdin.write('q');
    await flush();

    expect(fake.stop).toHaveBeenCalled();
  });
});
