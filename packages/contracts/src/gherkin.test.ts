import { describe, expect, it } from 'vitest';

import { AcceptanceCriterionSchema } from './gherkin.js';
import { deserialize, serialize } from './serde.js';

describe('AcceptanceCriterionSchema', () => {
  it('round-trips a fixture with given/when/then', () => {
    const fixture = {
      name: 'User signs in',
      given: ['a registered account'],
      when: ['they submit valid credentials'],
      then: ['they land on the dashboard'],
    };

    const raw = serialize(AcceptanceCriterionSchema, fixture);
    expect(deserialize(AcceptanceCriterionSchema, raw)).toEqual(fixture);
  });

  it('round-trips a fixture with an empty given', () => {
    const fixture = {
      name: 'App boots',
      given: [],
      when: ['the process starts'],
      then: ['it listens on the configured port'],
    };

    const raw = serialize(AcceptanceCriterionSchema, fixture);
    expect(deserialize(AcceptanceCriterionSchema, raw)).toEqual(fixture);
  });

  it('rejects an empty then array', () => {
    const invalid = { name: 'Broken', given: [], when: ['something happens'], then: [] };
    expect(() => AcceptanceCriterionSchema.parse(invalid)).toThrow();
  });
});
