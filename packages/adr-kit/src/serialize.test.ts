import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_NYGARD,
  CLASSIC_NYGARD,
  CRLF_NYGARD,
  MADR,
  NON_CANONICAL,
  REJECTED_NYGARD,
  SUPERSEDED_NYGARD,
  WITH_EXTRA_SECTION,
} from './__fixtures__/adrs.js';
import { createAdr } from './adr.js';
import { NYGARD_CONVENTION } from './convention.js';
import { inferConvention, parseAdr } from './parse.js';
import { serializeAdr } from './serialize.js';

const DATE_AS_SECTION = `# ADR-0010: Sections style with a Date section

## Status

Accepted

## Date

2026-07-16

## Context

Body.

## Decision

Body.

## Consequences

Body.
`;

describe('serializeAdr — byte-stable round trip', () => {
  it.each([
    ['ACCEPTED_NYGARD', ACCEPTED_NYGARD],
    ['SUPERSEDED_NYGARD', SUPERSEDED_NYGARD],
    ['REJECTED_NYGARD', REJECTED_NYGARD],
    ['CLASSIC_NYGARD', CLASSIC_NYGARD],
    ['MADR', MADR],
    ['WITH_EXTRA_SECTION', WITH_EXTRA_SECTION],
    ['CRLF_NYGARD', CRLF_NYGARD],
    ['DATE_AS_SECTION', DATE_AS_SECTION],
  ])('reproduces %s exactly', (_name, text) => {
    expect(serializeAdr(parseAdr(text), inferConvention(text))).toBe(text);
  });
});

describe('serializeAdr — idempotence on non-canonical input', () => {
  it('a second round trip matches the first', () => {
    const first = serializeAdr(parseAdr(NON_CANONICAL), inferConvention(NON_CANONICAL));
    const second = serializeAdr(parseAdr(first), inferConvention(first));
    expect(second).toBe(first);
  });
});

describe('serializeAdr — default template', () => {
  it('emits the full Nygard template with no References section', () => {
    const adr = createAdr({ number: 5, title: 'Use X', date: '2026-07-25' });
    const result = serializeAdr(adr);
    expect(result).toContain('# ADR-0005: Use X');
    expect(result).toContain('- Status: Proposed');
    expect(result).toContain('- Date: 2026-07-25');
    expect(result).toContain('## Context');
    expect(result).toContain('## Decision');
    expect(result).toContain('## Consequences');
    expect(result).not.toContain('References');
  });

  it('emits a References section when a reference is present', () => {
    const adr = createAdr({
      number: 5,
      title: 'Use X',
      date: '2026-07-25',
      references: [{ text: 'text', url: 'url', marker: '-' }],
    });
    const result = serializeAdr(adr);
    expect(result).toContain('## References');
    expect(result).toContain('- [text](url)');
  });

  it('degrades to a plain H1 when number is undefined and titleStyle is adr-prefix', () => {
    const adr = createAdr({ title: 'Untitled decision' });
    const result = serializeAdr(adr);
    expect(result.split('\n')[0]).toBe('# Untitled decision');
  });

  it('renders Status and Date as their own sections for a sections-style convention', () => {
    const adr = createAdr({ number: 1, title: 'Sections style', status: 'Accepted', date: '2026-07-16' });
    const convention = { ...NYGARD_CONVENTION, metaStyle: 'sections' as const };
    const result = serializeAdr(adr, convention);
    expect(result).toContain('## Status\n\nAccepted');
    expect(result).toContain('## Date\n\n2026-07-16');
  });
});
