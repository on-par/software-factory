import { describe, expect, it } from 'vitest';

import { DesignArtifactSchema } from './design.js';
import { deserialize, serialize } from './serde.js';

const validDesign = {
  restatedProblem: 'PLAN output is unstructured markdown.',
  approach: {
    chosen: 'Add a design: block to the frontmatter.',
    rejected: [{ option: 'Separate file only', reason: 'BUILD would need an extra read.' }],
  },
  interfacesTouched: ['packages/core/src/types/index.ts'],
  targetTypes: [{ name: 'DesignArtifact', file: 'packages/contracts/src/design.ts', kind: 'changed' as const }],
  signatures: [
    {
      symbol: 'renderDesignGrounding',
      file: 'packages/core/src/design/index.ts',
      signature: '(artifact: DesignArtifact) => string',
    },
  ],
  callGraph: [{ from: 'buildPhase', to: 'renderDesignGrounding', note: 'grounding block for the worker prompt' }],
  behaviorContract: ['PLAN emits a validated design artifact.'],
  verificationPlan: [{ command: 'bash scripts/verify.sh', passWhen: 'all checks green' }],
  riskBlastRadius: 'If wrong, PLAN output quality regresses to today.',
  openQuestions: [],
};

describe('DesignArtifactSchema', () => {
  it('round-trips a fixture with rejected approaches, a verification plan, and no open questions', () => {
    const raw = serialize(DesignArtifactSchema, validDesign);
    expect(deserialize(DesignArtifactSchema, raw)).toEqual(validDesign);
  });

  it('rejects a payload missing riskBlastRadius', () => {
    const { riskBlastRadius, ...withoutRisk } = validDesign;
    void riskBlastRadius;
    expect(() => DesignArtifactSchema.parse(withoutRisk)).toThrow();
  });

  it('parses a legacy payload omitting targetTypes/signatures/callGraph to empty arrays', () => {
    const { targetTypes, signatures, callGraph, ...legacy } = validDesign;
    void targetTypes;
    void signatures;
    void callGraph;
    const parsed = DesignArtifactSchema.parse(legacy);
    expect(parsed.targetTypes).toEqual([]);
    expect(parsed.signatures).toEqual([]);
    expect(parsed.callGraph).toEqual([]);
  });

  it('defaults a targetTypes entry without kind to "changed"', () => {
    const parsed = DesignArtifactSchema.parse({
      ...validDesign,
      targetTypes: [{ name: 'Foo', file: 'foo.ts' }],
    });
    expect(parsed.targetTypes[0].kind).toBe('changed');
  });

  it('throws when a signatures entry is missing signature', () => {
    expect(() =>
      DesignArtifactSchema.parse({
        ...validDesign,
        signatures: [{ symbol: 'foo', file: 'foo.ts' }],
      }),
    ).toThrow();
  });

  it('throws when a callGraph entry is missing to', () => {
    expect(() =>
      DesignArtifactSchema.parse({
        ...validDesign,
        callGraph: [{ from: 'a' }],
      }),
    ).toThrow();
  });

  it('parses a callGraph entry without note, leaving note undefined', () => {
    const parsed = DesignArtifactSchema.parse({
      ...validDesign,
      callGraph: [{ from: 'a', to: 'b' }],
    });
    expect(parsed.callGraph[0].note).toBeUndefined();
  });

  it('parses an explicit null for targetTypes/signatures/callGraph to empty arrays (a bare YAML key, not an omitted one)', () => {
    // js-yaml parses a bare `key:` with no following items as null, not undefined —
    // .default() only substitutes for undefined, so this must not fail the whole parse.
    const parsed = DesignArtifactSchema.parse({
      ...validDesign,
      targetTypes: null,
      signatures: null,
      callGraph: null,
    });
    expect(parsed.targetTypes).toEqual([]);
    expect(parsed.signatures).toEqual([]);
    expect(parsed.callGraph).toEqual([]);
  });

  describe('edgeInputs/behaviorDelta/externalLists', () => {
    const row = {
      input: 'null design key',
      branch: 'parse',
      before: 'fails',
      after: 'undefined',
      verdict: 'better' as const,
    };
    const list = {
      name: 'ParkReason',
      location: 'packages/core/src/park.ts',
      source: 'hand-maintained enum',
      gaps: ['no held-on-merge value'],
    };
    const extended = {
      ...validDesign,
      edgeInputs: ['empty issue body', 'unicode title'],
      behaviorDelta: [row],
      externalLists: [list],
    };

    it('validates and preserves the new fields, including through serde', () => {
      const parsed = DesignArtifactSchema.parse(extended);
      expect(parsed.edgeInputs).toEqual(extended.edgeInputs);
      expect(parsed.behaviorDelta).toEqual(extended.behaviorDelta);
      expect(parsed.externalLists).toEqual(extended.externalLists);
      const raw = serialize(DesignArtifactSchema, extended);
      expect(deserialize(DesignArtifactSchema, raw)).toEqual(extended);
    });

    it('still validates old artifacts, leaving the fields undefined', () => {
      const parsed = DesignArtifactSchema.parse(validDesign);
      expect(parsed.edgeInputs).toBeUndefined();
      expect(parsed.behaviorDelta).toBeUndefined();
      expect(parsed.externalLists).toBeUndefined();
    });

    it('parses bare YAML keys (null) to undefined', () => {
      const parsed = DesignArtifactSchema.parse({
        ...validDesign,
        edgeInputs: null,
        behaviorDelta: null,
        externalLists: null,
      });
      expect(parsed.edgeInputs).toBeUndefined();
      expect(parsed.behaviorDelta).toBeUndefined();
      expect(parsed.externalLists).toBeUndefined();
    });

    it('rejects an invalid verdict with a path to the verdict', () => {
      const result = DesignArtifactSchema.safeParse({ ...validDesign, behaviorDelta: [{ ...row, verdict: 'meh' }] });
      expect(result.success).toBe(false);
      expect(
        result.error?.issues.some((i) => JSON.stringify(i.path) === JSON.stringify(['behaviorDelta', 0, 'verdict'])),
      ).toBe(true);
    });

    it.each(['same', 'better', 'worse', 'unknown'])('accepts verdict %s', (verdict) => {
      expect(() => DesignArtifactSchema.parse({ ...validDesign, behaviorDelta: [{ ...row, verdict }] })).not.toThrow();
    });

    it('enforces required sub-fields', () => {
      const { source, ...noSource } = list;
      void source;
      expect(() => DesignArtifactSchema.parse({ ...validDesign, externalLists: [noSource] })).toThrow();
      expect(() =>
        DesignArtifactSchema.parse({ ...validDesign, externalLists: [{ ...list, gaps: [] }] }),
      ).not.toThrow();
      const { verdict, ...noVerdict } = row;
      void verdict;
      expect(() => DesignArtifactSchema.parse({ ...validDesign, behaviorDelta: [noVerdict] })).toThrow();
    });
  });
});
