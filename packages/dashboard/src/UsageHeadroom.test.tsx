// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { USAGE_UNAVAILABLE_REASON, type UsageHeadroomReading } from './usageHeadroomState.js';
import { UsageHeadroom } from './UsageHeadroom.js';

afterEach(cleanup);

const READING: UsageHeadroomReading = {
  pct: 0.42,
  cap: 227,
  source: 'subscription',
  nextPollAt: '2026-08-19T00:05:30.000Z',
};

describe('UsageHeadroom', () => {
  it('renders the percentage, cap, source, and next-poll time when a reading is available', () => {
    render(<UsageHeadroom usage={READING} />);

    expect(screen.getByRole('region', { name: 'Usage headroom' })).toBeDefined();
    expect(screen.getByText('42%')).toBeDefined();
    expect(screen.getByText('$227')).toBeDefined();
    expect(screen.getByText('subscription signal (% of plan limit)')).toBeDefined();
    expect(screen.getByText('00:05:30 UTC')).toBeDefined();

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('renders the explicit unavailable state with no progressbar and no numbers when usage is null', () => {
    render(<UsageHeadroom usage={null} />);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe(USAGE_UNAVAILABLE_REASON);
    expect(screen.queryByRole('progressbar')).toBeNull();

    const region = screen.getByRole('region', { name: 'Usage headroom' });
    expect(region.textContent).not.toMatch(/%/);
    expect(region.textContent?.toLowerCase()).not.toContain('armed');
    expect(region.textContent?.toLowerCase()).not.toContain('active');
  });

  it('clamps the bar width to 100% while reporting the true aria-valuenow above 100', () => {
    render(<UsageHeadroom usage={{ ...READING, pct: 1.4 }} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('140');
    expect(bar.getAttribute('style')).toContain('width: 100%');
  });
});
