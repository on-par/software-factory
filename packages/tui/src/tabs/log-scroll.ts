import type { FactoryEvent } from '@on-par/factory-core';

export interface LogScrollState {
  follow: boolean;
  /** Lines scrolled up from the tail. 0 = pinned to the newest event. */
  offset: number;
}

export function initialLogScroll(): LogScrollState {
  return { follow: true, offset: 0 };
}

export type LogScrollAction = 'up' | 'down' | 'pageUp' | 'pageDown' | 'toggleFollow';

export function reduceLogScroll(s: LogScrollState, a: LogScrollAction, pageSize: number, total: number): LogScrollState {
  const maxOffset = Math.max(0, total - pageSize);

  switch (a) {
    case 'up':
      return { follow: false, offset: Math.min(maxOffset, s.offset + 1) };
    case 'pageUp':
      return { follow: false, offset: Math.min(maxOffset, s.offset + pageSize) };
    case 'down':
      return { ...s, offset: Math.max(0, s.offset - 1) };
    case 'pageDown':
      return { ...s, offset: Math.max(0, s.offset - pageSize) };
    case 'toggleFollow': {
      const follow = !s.follow;
      return { follow, offset: follow ? 0 : s.offset };
    }
  }
}

export interface VisibleSlice {
  slice: FactoryEvent[];
  first: number;
  last: number;
}

/** Windowed view of `events` for the given scroll state. 1-based first/last for display; total = events.length. */
export function visibleSlice(events: FactoryEvent[], s: LogScrollState, height: number): VisibleSlice {
  const total = events.length;
  if (total === 0) return { slice: [], first: 0, last: 0 };

  const maxOffset = Math.max(0, total - height);
  const offset = Math.min(s.offset, maxOffset);
  const end = total - offset;
  const start = Math.max(0, end - height);

  return { slice: events.slice(start, end), first: start + 1, last: end };
}
