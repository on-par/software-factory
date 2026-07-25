import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_NYGARD,
  CLASSIC_NYGARD,
  MADR,
  REJECTED_NYGARD,
  SUPERSEDED_NYGARD,
  WITH_EXTRA_SECTION,
} from './__fixtures__/adrs.js';
import { AdrKitError } from './adr.js';
import { NYGARD_CONVENTION } from './convention.js';
import { detectConvention, inferConvention, parseAdr, tryParseAdr } from './parse.js';

describe('parseAdr — ACCEPTED_NYGARD', () => {
  it('parses number, title, status, date, and non-empty sections', () => {
    const adr = parseAdr(ACCEPTED_NYGARD);
    expect(adr.number).toBe(1);
    expect(adr.title).toBe('Use fixture ADRs to test the kit');
    expect(adr.status).toBe('Accepted');
    expect(adr.date).toBe('2026-07-16');
    expect(adr.context.length).toBeGreaterThan(0);
    expect(adr.decision.length).toBeGreaterThan(0);
    expect(adr.consequences.length).toBeGreaterThan(0);
    expect(adr.references).toHaveLength(2);
    expect(adr.references[0].url).toBeDefined();
    expect(adr.references[1].url).toBeDefined();
  });
});

describe('parseAdr — status fixtures', () => {
  it('parses SUPERSEDED_NYGARD', () => {
    expect(parseAdr(SUPERSEDED_NYGARD).status).toBe('Superseded by ADR-0007');
  });

  it('parses REJECTED_NYGARD with no references', () => {
    const adr = parseAdr(REJECTED_NYGARD);
    expect(adr.status).toBe('Rejected');
    expect(adr.references).toEqual([]);
  });
});

describe('parseAdr — CLASSIC_NYGARD', () => {
  it('reads the number from the numbered-dot H1, status from its section, and date from the bare preamble line', () => {
    const adr = parseAdr(CLASSIC_NYGARD);
    expect(adr.number).toBe(1);
    expect(adr.status).toBe('Accepted');
    expect(adr.date).toBe('2026-07-16');
  });
});

describe('parseAdr — MADR', () => {
  it('reads status/date from frontmatter and maps MADR section names', () => {
    const adr = parseAdr(MADR);
    expect(adr.status).toBe('accepted');
    expect(adr.date).toBe('2026-07-16');
    expect(adr.context.length).toBeGreaterThan(0);
    expect(adr.decision.length).toBeGreaterThan(0);
  });
});

describe('parseAdr — WITH_EXTRA_SECTION', () => {
  it('preserves an unrecognised heading in extraSections and sectionOrder', () => {
    const adr = parseAdr(WITH_EXTRA_SECTION);
    expect(adr.sectionOrder).toContain('Alternatives Considered');
    expect(adr.extraSections).toHaveLength(1);
    expect(adr.extraSections[0].heading).toBe('Alternatives Considered');
    expect(adr.extraSections[0].body.length).toBeGreaterThan(0);
  });
});

describe('parseAdr — unstructured references', () => {
  it('leaves references empty and files the section as extra when a body line matches no bullet form', () => {
    const source = `# ADR-0009: Unstructured references

- Status: Accepted
- Date: 2026-07-16

## Context

Body.

## Decision

Body.

## Consequences

Body.

## References

See the meeting notes for details.
`;
    const adr = parseAdr(source);
    expect(adr.references).toEqual([]);
    expect(adr.extraSections.find((section) => section.heading === 'References')).toBeDefined();
  });
});

describe('parseAdr — Date as its own section', () => {
  it('reads the date from a ## Date section when the document splits Status and Date into sections', () => {
    const source = `# ADR-0010: Sections style with a Date section

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
    const adr = parseAdr(source);
    expect(adr.status).toBe('Accepted');
    expect(adr.date).toBe('2026-07-16');
    expect(adr.sectionOrder).toContain('Date');
  });
});

describe('parseAdr — leniency and edge cases', () => {
  it('parses a title-only document leniently', () => {
    const adr = parseAdr('# Title only');
    expect(adr.number).toBeUndefined();
    expect(adr.status).toBe('');
    expect(adr.date).toBe('');
    expect(adr.context).toBe('');
    expect(adr.sectionOrder).toEqual([]);
  });

  it('falls back to the filename for the number when the H1 carries none', () => {
    const adr = parseAdr('# Title', { filename: '0042-x.md' });
    expect(adr.number).toBe(42);
  });

  it('throws AdrKitError with code parse when there is no H1', () => {
    expect(() => parseAdr('no h1 here')).toThrow(AdrKitError);
    try {
      parseAdr('no h1 here');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AdrKitError);
      expect((error as AdrKitError).code).toBe('parse');
    }
  });
});

describe('tryParseAdr', () => {
  it('returns ok:true with the adr and convention on success', () => {
    const result = tryParseAdr(ACCEPTED_NYGARD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adr.status).toBe('Accepted');
      expect(result.convention.titleStyle).toBe('adr-prefix');
    }
  });

  it('returns ok:false with the thrown message on failure', () => {
    const result = tryParseAdr('no h1 here');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(['adr has no H1 title']);
    }
  });
});

describe('inferConvention', () => {
  it('infers the Nygard convention from ACCEPTED_NYGARD', () => {
    const convention = inferConvention(ACCEPTED_NYGARD);
    expect(convention.titleStyle).toBe('adr-prefix');
    expect(convention.metaStyle).toBe('bullet-list');
    expect(convention.metaBullet).toBe('- ');
    expect(convention.eol).toBe('\n');
  });

  it('infers the numbered-dot / sections style from CLASSIC_NYGARD', () => {
    const convention = inferConvention(CLASSIC_NYGARD);
    expect(convention.titleStyle).toBe('numbered-dot');
    expect(convention.metaStyle).toBe('sections');
    expect(convention.metaBullet).toBe('');
  });

  it('infers the frontmatter style and MADR labels from MADR', () => {
    const convention = inferConvention(MADR);
    expect(convention.metaStyle).toBe('frontmatter');
    expect(convention.contextLabel).toBe('Context and Problem Statement');
    expect(convention.decisionLabel).toBe('Decision Outcome');
  });
});

describe('detectConvention', () => {
  it('returns NYGARD_CONVENTION for an empty list', () => {
    expect(detectConvention([])).toEqual(NYGARD_CONVENTION);
  });

  it('returns the field-wise modal convention, reusing the repo convention', () => {
    const convention = detectConvention([MADR, MADR, ACCEPTED_NYGARD]);
    expect(convention.metaStyle).toBe('frontmatter');
  });

  it('falls back to NYGARD_CONVENTION when every document fails to parse', () => {
    expect(detectConvention(['garbage'])).toEqual(NYGARD_CONVENTION);
  });

  it('breaks a 1-1 tie in favour of the first document', () => {
    const convention = detectConvention([MADR, ACCEPTED_NYGARD]);
    expect(convention.metaStyle).toBe('frontmatter');
  });
});
