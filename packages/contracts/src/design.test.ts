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
});
