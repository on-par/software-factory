import { defaultModelsConfig } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FAILOVER_TRIGGERS,
  FAILOVER_TRIGGER_KINDS,
  failoverConfigWarnings,
  FailoverTriggersSchema,
} from './failover-triggers.js';

const messages = (input: unknown): string[] => {
  const result = FailoverTriggersSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('FailoverTriggersSchema', () => {
  it('accepts every trigger kind and the empty list', () => {
    expect(FailoverTriggersSchema.parse([...FAILOVER_TRIGGER_KINDS])).toEqual([...FAILOVER_TRIGGER_KINDS]);
    expect(FailoverTriggersSchema.parse([])).toEqual([]);
  });

  it('rejects other as a deterministic kind, naming its index', () => {
    expect(messages(['rate_limit', 'other'])).toEqual([expect.stringMatching(/^1: 'other' is a deterministic/)]);
  });

  it.each(['timeout', 'error', 'empty_response', 'cli_missing', 'unknown', 'local_auth'])(
    'rejects legacy reason %s with a hint to use unavailable',
    (reason) => {
      expect(messages([reason])).toEqual([`0: '${reason}' is a failure reason, not a kind; use 'unavailable'`]);
    },
  );

  it('rejects unknown and empty entries', () => {
    expect(messages(['bogus'])).toEqual(["0: 'bogus' is not a failure kind; use rate_limit, unavailable or auth"]);
    expect(messages([''])).toHaveLength(1);
  });

  it('rejects non-string entries', () => {
    expect(messages([3])).toHaveLength(1);
  });
});

describe('DEFAULT_FAILOVER_TRIGGERS', () => {
  it('equals the packaged default', () => {
    expect([...DEFAULT_FAILOVER_TRIGGERS]).toEqual(defaultModelsConfig.failover.triggers);
  });
});

describe('failoverConfigWarnings', () => {
  it('returns nothing for a clean section and for non-object input', () => {
    expect(failoverConfigWarnings({ triggers: ['rate_limit'] }, 'failover')).toEqual([]);
    for (const input of [undefined, null, 'x', 3, ['usage_cap']]) {
      expect(failoverConfigWarnings(input, 'failover')).toEqual([]);
    }
  });

  it('warns once that a usage_cap trigger has no effect', () => {
    const warnings = failoverConfigWarnings({ triggers: ['usage_cap', 'auth'] }, 'models.failover');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('models.failover.triggers');
    expect(warnings[0]).toContain('usage_cap');
  });

  it('warns once that escalateAfterTierExhausted is deprecated', () => {
    const warnings = failoverConfigWarnings({ escalateAfterTierExhausted: false }, 'failover');
    expect(warnings).toEqual(['failover.escalateAfterTierExhausted is deprecated and ignored; remove it']);
  });

  it('reports both findings together', () => {
    expect(
      failoverConfigWarnings({ triggers: ['usage_cap'], escalateAfterTierExhausted: true }, 'failover'),
    ).toHaveLength(2);
  });
});
