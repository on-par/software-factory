import { describe, expect, it } from 'vitest';

import { describeBaseHealthEvidence } from './base-health.js';

// describeBaseHealthEvidence renders the evidence the lane-paused event, base hold and status quote.
describe('describeBaseHealthEvidence tail rendering', () => {
  const line = (tail: string) => describeBaseHealthEvidence([{ checker: 'tests', exitCode: 1, tail }]);

  it('joins lines with a single separator, dropping blank lines and indentation', () => {
    expect(line('first\n\n   \n  second  \r\n\t third\n')).toBe('tests: exit 1: first | second | third');
  });

  it('renders no tail suffix when the tail is only whitespace and newlines', () => {
    expect(line(' \n \n')).toBe('tests: exit 1');
  });

  it('renders a 100k-space tail without a newline in linear time', () => {
    expect(line(`a${' '.repeat(100_000)}b`)).toBe(`tests: exit 1: a${' '.repeat(100_000)}b`);
  });
});
