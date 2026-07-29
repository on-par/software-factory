import { describe, expect, it } from 'vitest';

import { AdapterError } from './checkpoint.js';

describe('AdapterError', () => {
  it('sets its name and carries the message', () => {
    const err = new AdapterError('boom');
    expect(err.name).toBe('AdapterError');
    expect(err.message).toBe('boom');
    expect(err).toBeInstanceOf(Error);
  });
});
