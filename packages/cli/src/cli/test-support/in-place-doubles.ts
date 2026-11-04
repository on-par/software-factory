import { vi } from 'vitest';

import type { CliDeps } from '../index.js';

/** In-place workspace doubles (#3904): a clean checkout by default, and a switch that succeeds. */
export const checkInPlaceCheckout = vi.fn<NonNullable<CliDeps['checkInPlaceCheckout']>>(async () => null);
export const setupInPlaceCheckout = vi.fn<NonNullable<CliDeps['setupInPlaceCheckout']>>(async () => ({
  base: 'origin/main',
  head: 'abc',
  remoteBranch: null,
}));
