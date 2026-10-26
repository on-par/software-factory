import type { EventKind, FactoryEvent } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App, type QueueReader } from './App.js';

afterEach(cleanup);

function makeFakeFollow() {
  let onEvent: ((e: FactoryEvent) => void) | undefined;
  const follow = vi.fn((_file: string, cb: (e: FactoryEvent) => void) => {
    onEvent = cb;
    return vi.fn();
  });
  return { follow, push: (e: FactoryEvent) => onEvent?.(e) };
}

function ev(type: EventKind, msg: string, issue = '192', ts = new Date().toISOString()): FactoryEvent {
  return { ts, type, issue, msg };
}

/** Ink schedules re-renders on a microtask; flush it before reading lastFrame(). */
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('App idle reason and run summary (#1365)', () => {
  it('shows no active work with the GitHub-queue-empty reason when idle and the queue is empty (#1365)', async () => {
    const fake = makeFakeFollow();
    const queueReader: QueueReader = { source: 'GitHub', read: vi.fn(async () => ({ entries: [] })) };
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} queueReader={queueReader} />);
    await vi.waitFor(() => expect(queueReader.read).toHaveBeenCalled());
    await flush();
    expect(lastFrame()).toContain('no active work — GitHub queue empty');
  });

  it('shows no active work with the parked/finished reason when every lane is terminal and the queue is non-empty (#1365)', async () => {
    const fake = makeFakeFollow();
    const queueReader: QueueReader = {
      source: 'GitHub',
      read: vi.fn(async () => ({ entries: [{ lane: 'app', issue: 300 }] })),
    };
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} queueReader={queueReader} />);
    fake.push(ev('plan', 'Starting plan phase', '192'));
    fake.push(ev('parked', 'parked', '192'));
    await vi.waitFor(() => expect(queueReader.read).toHaveBeenCalled());
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('no active work — all runs parked/finished');
    expect(frame).toContain('#192');
  });

  it('shows bare no active work before the queue reader resolves (#1365)', async () => {
    const fake = makeFakeFollow();
    const queueReader: QueueReader = { source: 'GitHub', read: () => new Promise(() => {}) };
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} queueReader={queueReader} />);
    await flush();
    expect(lastFrame()).toContain('no active work');
    expect(lastFrame()).not.toContain('queue empty');
  });

  it('shows issue, title, phase, elapsed and last activity in one compact header block for a single running lane (#1365)', async () => {
    const fake = makeFakeFollow();
    const old = new Date(Date.now() - 125_000).toISOString();
    const { lastFrame } = render(<App eventsFile="ignored" follow={fake.follow} />);
    fake.push(ev('plan', 'Starting plan phase', '192', old));
    fake.push(ev('issue-title', 'Fix the widget', '192', old));
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Factory — issue #192');
    expect(frame).toContain('Fix the widget');
    expect(frame).toContain('PLAN');
    expect(frame).toContain('elapsed 02:');
    expect(frame).toContain('last activity 2m ago');
    const lines = frame.split('\n');
    const at = lines.findIndex((l) => l.includes('Factory — issue #192'));
    expect(lines[at + 1]).toContain('Fix the widget');
    expect(lines[at + 1]).toContain('last activity 2m ago');
  });
});
