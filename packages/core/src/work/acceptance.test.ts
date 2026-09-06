import { describe, expect, it } from 'vitest';

import { extractAcceptanceCriteria } from './acceptance.js';

describe('extractAcceptanceCriteria', () => {
  it('groups each named Gherkin scenario and excludes surrounding research and verification bullets', () => {
    const scenarios = ['initial state', 'changed state', 'restored state'].map(
      (name) =>
        `Scenario: ${name}\nGiven a widget\nWhen its state changes\nThen the display matches\nAnd the update is visible`,
    );
    const body = [
      '## Research',
      '- [ ] investigate implementation choices',
      '## Acceptance criteria (Gherkin)',
      '```gherkin',
      'Feature: display follows widget state',
      ...scenarios,
      '```',
      '## Verification',
      '- [ ] run the suite',
      '## INVEST',
      '- independent',
      '- small',
    ].join('\n');
    expect(extractAcceptanceCriteria(body)).toEqual(scenarios);
  });

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
    expect(extractAcceptanceCriteria(body)).toEqual(['**Scenario: it works**\nGiven something']);
  });

  it('returns [] when there is no Acceptance criteria heading at all', () => {
    expect(extractAcceptanceCriteria('### Problem statement\n\nno AC here\n')).toEqual([]);
  });
});
