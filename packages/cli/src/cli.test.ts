import { describe, expect, it } from 'vitest';
import { main } from './cli/index.js';

describe('cli', () => {
  it('exports the main entrypoint', () => {
    expect(typeof main).toBe('function');
  });
});
