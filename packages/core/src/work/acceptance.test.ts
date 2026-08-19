import { describe, expect, it } from 'vitest';

import { extractAcceptanceCriteria } from './acceptance.js';

describe('extractAcceptanceCriteria', () => {
  it('extracts checkbox lines from an exact "Acceptance criteria" heading', () => {
    const body = `
### Acceptance criteria

- [ ] first
- [x] second
`;
    expect(extractAcceptanceCriteria(body)).toEqual(['first', 'second']);
  });

  it('extracts checkbox lines from a heading with a parenthetical suffix', () => {
    const body = `
### Acceptance criteria (Gherkin)

- [ ] **Scenario: it works**
      Given something
`;
    expect(extractAcceptanceCriteria(body)).toEqual(['**Scenario: it works**', 'Given something']);
  });

  it('returns [] when there is no Acceptance criteria heading at all', () => {
    expect(extractAcceptanceCriteria('### Problem statement\n\nno AC here\n')).toEqual([]);
  });
});
