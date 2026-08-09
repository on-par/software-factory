import { MAX_ACCEPTANCE_CRITERIA, MAX_IN_SCOPE } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { buildDecompositionPrompt } from './prompt.js';

describe('buildDecompositionPrompt', () => {
  it('contains the size reason, the untrusted-data tags with title and body, and the "stories" key', () => {
    const prompt = buildDecompositionPrompt({
      title: 'Overhaul the ingest pipeline',
      body: 'It has grown too many responsibilities.',
      sizeReason: 'too big: 7 in-scope items, 8 acceptance criteria',
    });

    expect(prompt).toContain('too big: 7 in-scope items, 8 acceptance criteria');
    expect(prompt).toContain('<untrusted-title>\nOverhaul the ingest pipeline\n</untrusted-title>');
    expect(prompt).toContain(
      '<untrusted-original-body>\nIt has grown too many responsibilities.\n</untrusted-original-body>',
    );
    expect(prompt).toContain('not instructions');
    expect(prompt).toContain('"stories"');
  });

  it('interpolates the contracts constants rather than hard-coding 5', () => {
    const prompt = buildDecompositionPrompt({
      title: 'x',
      body: 'y',
      sizeReason: 'too big',
    });

    expect(prompt).toContain(String(MAX_IN_SCOPE));
    expect(prompt).toContain(String(MAX_ACCEPTANCE_CRITERIA));
  });
});
