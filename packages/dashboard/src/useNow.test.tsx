// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNow } from './useNow.js';

afterEach(cleanup);

function Probe({ intervalMs, clock }: { intervalMs?: number; clock: () => number }) {
  const now = useNow(intervalMs, clock);
  return <span data-testid="now">{now}</span>;
}

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial clock value on mount', () => {
    const clock = vi.fn(() => 1_000);
    const { getByTestId } = render(<Probe intervalMs={1_000} clock={clock} />);
    expect(getByTestId('now').textContent).toBe('1000');
  });

  it('advances after intervalMs elapses', () => {
    let value = 1_000;
    const clock = () => value;
    const { getByTestId } = render(<Probe intervalMs={1_000} clock={clock} />);
    value = 2_000;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(getByTestId('now').textContent).toBe('2000');
  });

  it('clears its interval on unmount', () => {
    const clock = vi.fn(() => 1_000);
    const { unmount } = render(<Probe intervalMs={1_000} clock={clock} />);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
