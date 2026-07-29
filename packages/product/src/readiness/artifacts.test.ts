// packages/product/src/readiness/artifacts.test.ts (#475).

import { describe, expect, it } from 'vitest';

import { classifyArtifact, PROPOSER_ARTIFACT_KINDS, WRITER_ARTIFACT_KINDS } from './artifacts.js';

describe('classifyArtifact', () => {
  it('classifies every proposer-owned kind as proposer', () => {
    for (const kind of PROPOSER_ARTIFACT_KINDS) {
      expect(classifyArtifact(kind)).toBe('proposer');
    }
  });

  it('classifies every writer-owned kind as writer', () => {
    for (const kind of WRITER_ARTIFACT_KINDS) {
      expect(classifyArtifact(kind)).toBe('writer');
    }
  });

  it('classifies a story program design as writer-owned', () => {
    expect(classifyArtifact('story-program-design')).toBe('writer');
  });
});
