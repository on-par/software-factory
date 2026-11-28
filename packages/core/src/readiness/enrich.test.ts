import { describe, expect, it } from 'vitest';

import * as enrich from './enrich.js';
import { stripEnrichedBlock } from './enrich.js';

const START = '<!-- factory:enriched -->';
const END = '<!-- /factory:enriched -->';
const HEADING = "## Added by On PAR Dev's Software Factory";

describe('stripEnrichedBlock', () => {
  it('removes a legacy block and keeps the user text around it', () => {
    const body = `Before.\n\n${START}\n${HEADING}\n\nold\n${END}\n\nAfter edit.`;
    expect(stripEnrichedBlock(body)).toBe('Before.\n\n\nAfter edit.');
  });

  it('removes a trailing block and the whitespace before it', () => {
    expect(stripEnrichedBlock(`User text.\n\n${START}\nsections\n${END}`)).toBe('User text.');
  });

  it('removes every block', () => {
    expect(stripEnrichedBlock(`a\n${START}\none\n${END}\nb\n${START}\ntwo\n${END}`)).toBe('a\nb');
  });

  it('returns input unchanged when there is no marker', () => {
    const body = '  text with trailing space \n\n';
    expect(stripEnrichedBlock(body)).toBe(body);
  });

  it('cuts an unterminated block to the end of the text', () => {
    expect(stripEnrichedBlock(`keep\n\n${START}\nhand edited`)).toBe('keep');
  });
});

describe('enrichment is gone (ADR-0167, #3470)', () => {
  it('exports only stripEnrichedBlock', () => {
    expect(Object.keys(enrich)).toEqual(['stripEnrichedBlock']);
  });
});
