import { describe, expect, it } from 'vitest';

import { draftLeftMessage } from './run-lane-draft.js';

describe('draftLeftMessage', () => {
  it('names the landing, sweep and requested-draft cases', () => {
    expect(draftLeftMessage(7, true, true)).toContain('landing it');
    expect(draftLeftMessage(7, true, false)).toContain('between-issue sweep');
    expect(draftLeftMessage(7, false, false)).toContain('merge skipped');
  });
});
