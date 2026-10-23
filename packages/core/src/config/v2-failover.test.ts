import { describe, expect, it, vi } from 'vitest';

import { parseV2Config } from './v2.js';

describe('models.failover (#3228)', () => {
  const parse = (failover: Record<string, unknown>) => parseV2Config({ version: 2, models: { failover } });

  it('defaults triggers to the failure kinds', () => {
    expect(parseV2Config({ version: 2 }).models.failover.triggers).toEqual(['rate_limit', 'unavailable', 'auth']);
  });

  it.each([
    ['bogus', /Invalid v2 config: models\.failover\.triggers\.0: 'bogus' is not a failure kind/],
    ['other', /models\.failover\.triggers\.0: 'other' is a deterministic/],
    ['timeout', /models\.failover\.triggers\.0: 'timeout' is a failure reason, not a kind; use 'unavailable'/],
  ])('rejects the %s trigger naming the path and entry', (entry, pattern) => {
    expect(() => parse({ triggers: [entry] })).toThrow(pattern);
  });

  it('warns once for a usage_cap trigger and once for the deprecated key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      parse({ triggers: ['usage_cap'] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('usage_cap');
      warn.mockClear();
      const cfg = parse({ escalateAfterTierExhausted: true });
      expect(cfg.models.failover).not.toHaveProperty('escalateAfterTierExhausted');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('escalateAfterTierExhausted');
    } finally {
      warn.mockRestore();
    }
  });
});
