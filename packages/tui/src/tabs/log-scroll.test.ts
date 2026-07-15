import { describe, expect, it } from 'vitest';
import type { FactoryEvent } from '@on-par/factory-core';
import { initialLogScroll, reduceLogScroll, visibleSlice } from './log-scroll.js';

function events(n: number): FactoryEvent[] {
  return Array.from({ length: n }, (_, i) => ({ ts: `t${i}`, type: 'build', issue: '1', msg: `msg ${i}` }));
}

describe('initialLogScroll', () => {
  it('starts following at the tail', () => {
    expect(initialLogScroll()).toEqual({ follow: true, offset: 0 });
  });
});

describe('reduceLogScroll', () => {
  it('up increases offset and disables follow', () => {
    const s = reduceLogScroll({ follow: true, offset: 0 }, 'up', 10, 100);
    expect(s).toEqual({ follow: false, offset: 1 });
  });

  it('pageUp increases offset by pageSize and disables follow', () => {
    const s = reduceLogScroll({ follow: true, offset: 0 }, 'pageUp', 10, 100);
    expect(s).toEqual({ follow: false, offset: 10 });
  });

  it('up clamps offset at total - pageSize', () => {
    const s = reduceLogScroll({ follow: false, offset: 89 }, 'up', 10, 100);
    expect(s).toEqual({ follow: false, offset: 90 });
  });

  it('pageUp clamps offset at total - pageSize', () => {
    const s = reduceLogScroll({ follow: false, offset: 85 }, 'pageUp', 10, 100);
    expect(s).toEqual({ follow: false, offset: 90 });
  });

  it('down decreases offset toward zero, preserving follow state', () => {
    const s = reduceLogScroll({ follow: false, offset: 5 }, 'down', 10, 100);
    expect(s).toEqual({ follow: false, offset: 4 });
  });

  it('down clamps offset at zero', () => {
    const s = reduceLogScroll({ follow: false, offset: 0 }, 'down', 10, 100);
    expect(s).toEqual({ follow: false, offset: 0 });
  });

  it('pageDown decreases offset by pageSize, clamped at zero', () => {
    expect(reduceLogScroll({ follow: false, offset: 5 }, 'pageDown', 10, 100)).toEqual({ follow: false, offset: 0 });
    expect(reduceLogScroll({ follow: false, offset: 25 }, 'pageDown', 10, 100)).toEqual({ follow: false, offset: 15 });
  });

  it('toggleFollow flips follow and resets offset to 0 when turning on', () => {
    expect(reduceLogScroll({ follow: false, offset: 42 }, 'toggleFollow', 10, 100)).toEqual({ follow: true, offset: 0 });
  });

  it('toggleFollow flips follow off and preserves offset', () => {
    expect(reduceLogScroll({ follow: true, offset: 0 }, 'toggleFollow', 10, 100)).toEqual({ follow: false, offset: 0 });
  });

  it('maxOffset is zero when total fits within pageSize', () => {
    expect(reduceLogScroll({ follow: true, offset: 0 }, 'up', 10, 3)).toEqual({ follow: false, offset: 0 });
  });
});

describe('visibleSlice', () => {
  it('returns an empty slice for no events', () => {
    expect(visibleSlice([], { follow: true, offset: 0 }, 10)).toEqual({ slice: [], first: 0, last: 0 });
  });

  it('shows all events with correct bounds when fewer events than height', () => {
    const evs = events(3);
    const { slice, first, last } = visibleSlice(evs, { follow: true, offset: 0 }, 10);
    expect(slice).toEqual(evs);
    expect(first).toBe(1);
    expect(last).toBe(3);
  });

  it('shows the newest window when offset is 0 (follow)', () => {
    const evs = events(20);
    const { slice, first, last } = visibleSlice(evs, { follow: true, offset: 0 }, 5);
    expect(slice.map(e => e.msg)).toEqual(['msg 15', 'msg 16', 'msg 17', 'msg 18', 'msg 19']);
    expect(first).toBe(16);
    expect(last).toBe(20);
  });

  it('shows an older window when scrolled up by offset', () => {
    const evs = events(20);
    const { slice, first, last } = visibleSlice(evs, { follow: false, offset: 5 }, 5);
    expect(slice.map(e => e.msg)).toEqual(['msg 10', 'msg 11', 'msg 12', 'msg 13', 'msg 14']);
    expect(first).toBe(11);
    expect(last).toBe(15);
  });

  it('clamps the offset to the oldest possible window', () => {
    const evs = events(20);
    const { slice, first, last } = visibleSlice(evs, { follow: false, offset: 100 }, 5);
    expect(slice.map(e => e.msg)).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']);
    expect(first).toBe(1);
    expect(last).toBe(5);
  });
});
