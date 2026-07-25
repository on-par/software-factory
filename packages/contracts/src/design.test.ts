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
});
