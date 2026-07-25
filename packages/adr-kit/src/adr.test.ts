import { describe, expect, it } from 'vitest';

import { AdrKitError, createAdr, matchKnownField, normalizeStatus, supersededBy } from './adr.js';

describe('normalizeStatus', () => {
  it.each(['Proposed', 'Accepted', 'Rejected', 'Deprecated', 'Superseded'])('recognizes %s', (value) => {
    expect(normalizeStatus(value)).toBe(value);
  });

  it('is case-insensitive', () => {
    expect(normalizeStatus('accepted')).toBe('Accepted');
  });

  it('reads the first word of a longer raw status', () => {
    expect(normalizeStatus('Superseded by ADR-0007')).toBe('Superseded');
  });

  it('returns undefined for an unrecognised status', () => {
    expect(normalizeStatus('wat')).toBeUndefined();
  });
});

describe('supersededBy', () => {
  it('extracts the number from a Superseded by ADR-NNNN status', () => {
    expect(supersededBy('Superseded by ADR-0007')).toBe(7);
  });

  it('returns undefined when Superseded has no number', () => {
    expect(supersededBy('Superseded')).toBeUndefined();
  });

  it('returns undefined for a non-Superseded status', () => {
    expect(supersededBy('Accepted')).toBeUndefined();
  });
});

describe('createAdr', () => {
  it('fills defaults for an unspecified input', () => {
    const adr = createAdr({ title: 'Use X' });
    expect(adr).toEqual({
      number: undefined,
      title: 'Use X',
      status: 'Proposed',
      date: '',
      context: '',
      decision: '',
      consequences: '',
      references: [],
      sectionOrder: [],
      extraSections: [],
    });
  });

  it('honors overrides', () => {
    const adr = createAdr({
      number: 5,
      title: 'Use X',
      status: 'Accepted',
      date: '2026-07-25',
      context: 'ctx',
      decision: 'dec',
      consequences: 'cons',
      references: [{ text: 'ref', marker: '-' }],
    });
    expect(adr.number).toBe(5);
    expect(adr.status).toBe('Accepted');
    expect(adr.date).toBe('2026-07-25');
    expect(adr.context).toBe('ctx');
    expect(adr.decision).toBe('dec');
    expect(adr.consequences).toBe('cons');
    expect(adr.references).toEqual([{ text: 'ref', marker: '-' }]);
  });
});

describe('matchKnownField', () => {
  it.each([
    ['Status', 'status'],
    ['Date', 'date'],
    ['Context', 'context'],
    ['Context and Problem Statement', 'context'],
    ['Decision', 'decision'],
    ['Decision Outcome', 'decision'],
    ['Consequences', 'consequences'],
    ['References', 'references'],
    ['Links', 'references'],
  ])('maps %s to %s', (heading, field) => {
    expect(matchKnownField(heading)).toBe(field);
  });

  it('does not collide MADR Decision Drivers with Decision Outcome', () => {
    expect(matchKnownField('Decision Drivers')).toBeUndefined();
  });

  it('returns undefined for an unrecognised heading', () => {
    expect(matchKnownField('Alternatives Considered')).toBeUndefined();
  });
});

describe('AdrKitError', () => {
  it('carries name and code', () => {
    const error = new AdrKitError('boom', 'parse');
    expect(error.name).toBe('AdrKitError');
    expect(error.code).toBe('parse');
    expect(error.message).toBe('boom');
    expect(error).toBeInstanceOf(Error);
  });
});
