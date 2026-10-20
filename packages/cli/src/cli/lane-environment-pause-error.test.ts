import { describe, expect, it } from 'vitest';

import { LaneEnvironmentPauseError } from './lane-environment-pause-error.js';

describe('LaneEnvironmentPauseError', () => {
  it('preserves local confirmation from a released outcome', () => {
    const error = new LaneEnvironmentPauseError('base failed', {
      baseSha: 'a'.repeat(40),
      failingChecks: ['tests'],
      confirmedLocally: true,
    });
    expect(error.confirmedLocally).toBe(true);
  });

  it('leaves absent confirmation unset', () => {
    const error = new LaneEnvironmentPauseError('base failed', { baseSha: 'a'.repeat(40), failingChecks: ['tests'] });
    expect(error.confirmedLocally).toBeUndefined();
  });
});
