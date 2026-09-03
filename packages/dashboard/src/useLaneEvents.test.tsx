// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBrowserEventSource, useLaneEvents, type EventSourceLike } from './useLaneEvents.js';

afterEach(cleanup);

class FakeEventSource implements EventSourceLike {
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

function validEventJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: '2026-08-19T00:00:00.000Z',
    laneId: 'lane-1',
    issueId: '593',
    phase: 'plan',
    status: 'started',
    detail: 'planning',
    worktreePath: '/tmp/lane-1',
    ...overrides,
  });
}

function Probe({ source }: { source: FakeEventSource }) {
  const { board, connection } = useLaneEvents({ createEventSource: () => source });
  return (
    <div>
      <span data-testid="connection">{connection}</span>
      <span data-testid="lane-count">{board.lanes.length}</span>
    </div>
  );
}

describe('useLaneEvents', () => {
  it('lands a lane on the board from a valid lifecycle frame', () => {
    const source = new FakeEventSource();
    render(<Probe source={source} />);

    act(() => source.emit('lifecycle', validEventJson()));

    expect(screen.getByTestId('lane-count').textContent).toBe('1');
  });

  it('produces two lanes for two different laneIds', () => {
    const source = new FakeEventSource();
    render(<Probe source={source} />);

    act(() => {
      source.emit('lifecycle', validEventJson({ laneId: 'lane-a' }));
      source.emit('lifecycle', validEventJson({ laneId: 'lane-b' }));
    });

    expect(screen.getByTestId('lane-count').textContent).toBe('2');
  });

  it('ignores a frame whose data is not valid JSON', () => {
    const source = new FakeEventSource();
    render(<Probe source={source} />);

    act(() => source.emit('lifecycle', 'not json'));

    expect(screen.getByTestId('lane-count').textContent).toBe('0');
  });

  it('ignores a frame that fails LaneLifecycleEventSchema', () => {
    const source = new FakeEventSource();
    render(<Probe source={source} />);

    act(() => source.emit('lifecycle', validEventJson({ phase: 'deploy' })));

    expect(screen.getByTestId('lane-count').textContent).toBe('0');
  });

  it('reports connecting before open, live after open, and disconnected after an error', () => {
    const source = new FakeEventSource();
    render(<Probe source={source} />);

    expect(screen.getByTestId('connection').textContent).toBe('connecting');

    act(() => source.emit('open'));
    expect(screen.getByTestId('connection').textContent).toBe('live');

    act(() => source.emit('error'));
    expect(screen.getByTestId('connection').textContent).toBe('disconnected');
  });

  it('closes the source exactly once on unmount', () => {
    const source = new FakeEventSource();
    const { unmount } = render(<Probe source={source} />);

    expect(source.closed).toBe(false);
    unmount();
    expect(source.closed).toBe(true);
  });
});

describe('createBrowserEventSource', () => {
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalEventSource = globalThis.EventSource;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
  });

  it('returns an inert no-op source when globalThis.EventSource is undefined', () => {
    // @ts-expect-error -- deliberately simulating a non-browser host for this assertion
    delete globalThis.EventSource;

    const source = createBrowserEventSource('/events');
    expect(() => source.addEventListener('lifecycle', () => {})).not.toThrow();
    expect(() => source.close()).not.toThrow();
  });

  it('returns a real instance when globalThis.EventSource is defined', () => {
    let constructedUrl: string | undefined;

    class StubEventSource {
      constructor(url: string) {
        constructedUrl = url;
      }
      addEventListener(): void {}
      close(): void {}
    }

    // @ts-expect-error -- stubbing a minimal EventSource for this assertion
    globalThis.EventSource = StubEventSource;

    const source = createBrowserEventSource('/events');
    expect(source).toBeInstanceOf(StubEventSource);
    expect(constructedUrl).toBe('/events');
  });
});
