import { describe, expect, it } from 'vitest';

import { DesignArtifactSchema, coerceListItem, findCoercedDesignItems } from './design.js';
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

describe('design string-list coercion (#2216)', () => {
  const plain = Array.from({ length: 11 }, (_, i) => `item ${i}`);
  const mapItem = { 'a remote reusable workflow (`uses': 'org/repo/.github/workflows/x.yml@main`) — not followed' };
  const mapText = 'a remote reusable workflow (`uses: org/repo/.github/workflows/x.yml@main`) — not followed';

  it('rebuilds a one-key map in edgeInputs as the original line', () => {
    const design = { ...validDesign, edgeInputs: [...plain, mapItem] };
    const result = DesignArtifactSchema.safeParse(design);
    expect(result.success).toBe(true);
    expect(result.success && result.data.edgeInputs?.[11]).toBe(mapText);
    expect(findCoercedDesignItems(design)).toEqual(['edgeInputs[11]']);
  });

  it('turns a multi-key map in interfacesTouched into JSON text', () => {
    const item = { file: 'src/a.ts', symbol: 'run' };
    const result = DesignArtifactSchema.parse({ ...validDesign, interfacesTouched: [item] });
    expect(result.interfacesTouched[0]).toBe(JSON.stringify(item));
  });

  it('coerces numbers, nested lists, null and null-valued one-key maps', () => {
    const result = DesignArtifactSchema.parse({
      ...validDesign,
      behaviorContract: [42, ['a', 'b'], { foo: null }, { port: 8080 }, { k: { a: 1 } }],
      openQuestions: [null],
    });
    expect(result.behaviorContract).toEqual(['42', '["a","b"]', 'foo:', 'port: 8080', 'k: {"a":1}']);
    expect(result.openQuestions).toEqual(['null']);
  });

  it('coerces externalLists gaps and reports their path', () => {
    const design = {
      ...validDesign,
      externalLists: [{ name: 'n', location: 'l', source: 's', gaps: ['ok', 'ok2', mapItem] }],
    };
    const result = DesignArtifactSchema.parse(design);
    expect(result.externalLists?.[0]?.gaps[2]).toBe(mapText);
    expect(findCoercedDesignItems(design)).toEqual(['externalLists[0].gaps[2]']);
  });

  it('still rejects an empty-string edgeInputs item', () => {
    expect(DesignArtifactSchema.safeParse({ ...validDesign, edgeInputs: [''] }).success).toBe(false);
  });

  it('coerceListItem falls back to String for values JSON cannot represent', () => {
    expect(coerceListItem(undefined)).toBe('undefined');
    expect(coerceListItem('x')).toBe('x');
  });

  it('findCoercedDesignItems yields nothing for clean, null and non-array input', () => {
    expect(findCoercedDesignItems(validDesign)).toEqual([]);
    expect(findCoercedDesignItems(null)).toEqual([]);
    expect(findCoercedDesignItems({ edgeInputs: 'x', externalLists: [null, { gaps: 'x' }] })).toEqual([]);
  });
});

describe('evidencePlan', () => {
  const allKinds = [
    { kind: 'fail-to-pass-test' as const, claim: 'a', test: 'x.test.ts' },
    { kind: 'command' as const, claim: 'b', command: 'npm test', passWhen: 'exits 0' },
    { kind: 'screenshot' as const, claim: 'c', route: '/home' },
    { kind: 'none' as const, claim: 'd', reason: 'docs only' },
  ];
  const paths = (evidencePlan: unknown) => {
    const r = DesignArtifactSchema.safeParse({ ...validDesign, evidencePlan });
    return r.success ? null : r.error.issues.map((i) => i.path.join('.'));
  };

  it('accepts each kind and round-trips', () => {
    const r = DesignArtifactSchema.safeParse({ ...validDesign, evidencePlan: allKinds });
    expect(r.success).toBe(true);
    expect(r.data?.evidencePlan).toHaveLength(4);
    expect(r.data?.evidencePlan).toEqual(allKinds);
    const back = deserialize(
      DesignArtifactSchema,
      serialize(DesignArtifactSchema, { ...validDesign, evidencePlan: allKinds }),
    );
    expect(back.evidencePlan).toEqual(allKinds);
  });

  it('rejects a screenshot entry with no route', () => {
    expect(paths([{ kind: 'screenshot', claim: 'x' }])).toContain('evidencePlan.0.route');
  });

  it.each([
    [{ kind: 'fail-to-pass-test', claim: 'x' }, 'evidencePlan.0.test'],
    [{ kind: 'command', claim: 'x', command: 'c' }, 'evidencePlan.0.passWhen'],
    [{ kind: 'command', claim: 'x', passWhen: 'p' }, 'evidencePlan.0.command'],
    [{ kind: 'none', claim: 'x' }, 'evidencePlan.0.reason'],
    [{ kind: 'screenshot', route: '/a' }, 'evidencePlan.0.claim'],
    [{ kind: 'screenshot', claim: 'x', route: '' }, 'evidencePlan.0.route'],
  ])('rejects %j', (entry, path) => {
    expect(paths([entry])).toContain(path);
  });

  it('reports the index of the invalid entry', () => {
    expect(paths([allKinds[0], { kind: 'screenshot', claim: 'x' }])).toContain('evidencePlan.1.route');
  });

  it('rejects an unknown kind', () => {
    const p = paths([{ kind: 'video', claim: 'x' }]);
    expect(p?.some((x) => x.startsWith('evidencePlan.0.kind'))).toBe(true);
  });

  it('is optional and tolerates null', () => {
    const none = DesignArtifactSchema.safeParse(validDesign);
    expect(none.success).toBe(true);
    expect(none.data?.evidencePlan).toBeUndefined();
    const nul = DesignArtifactSchema.safeParse({ ...validDesign, evidencePlan: null });
    expect(nul.success).toBe(true);
    expect(nul.data?.evidencePlan).toBeUndefined();
  });
});
