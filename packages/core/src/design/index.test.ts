import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { specPaths } from '../spec/index.js';
import type { DesignArtifact } from '../types/index.js';
import { parseDesignArtifact, readDesignArtifact, renderDesignArtifact, renderDesignGrounding } from './index.js';

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

const artifact: DesignArtifact = validDesign;

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('parseDesignArtifact', () => {
  it('parses a valid full frontmatter design block', () => {
    const { artifact: parsed, errors } = parseDesignArtifact({ route: 'codex', design: validDesign });
    expect(errors).toEqual([]);
    expect(parsed).toEqual(validDesign);
  });

  it('returns null with an error mentioning the missing block when design is absent', () => {
    const { artifact: parsed, errors } = parseDesignArtifact({ route: 'codex' });
    expect(parsed).toBeNull();
    expect(errors).toEqual(['no design block in spec frontmatter']);
  });

  it('returns null and names the path when a required field is missing', () => {
    const { riskBlastRadius, ...withoutRisk } = validDesign;
    void riskBlastRadius;
    const { artifact: parsed, errors } = parseDesignArtifact({ design: withoutRisk });
    expect(parsed).toBeNull();
    expect(errors.some((e) => e.startsWith('riskBlastRadius'))).toBe(true);
  });

  it('returns null when a field has the wrong type', () => {
    const { artifact: parsed, errors } = parseDesignArtifact({
      design: { ...validDesign, openQuestions: 'none' },
    });
    expect(parsed).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts empty openQuestions and empty rejected arrays', () => {
    const { artifact: parsed, errors } = parseDesignArtifact({
      design: { ...validDesign, openQuestions: [], approach: { ...validDesign.approach, rejected: [] } },
    });
    expect(errors).toEqual([]);
    expect(parsed?.openQuestions).toEqual([]);
    expect(parsed?.approach.rejected).toEqual([]);
  });

  it('returns null for non-object frontmatter', () => {
    const { artifact: parsed, errors } = parseDesignArtifact(null);
    expect(parsed).toBeNull();
    expect(errors).toEqual(['no design block in spec frontmatter']);
  });
});

describe('renderDesignArtifact', () => {
  it('contains every section heading, rejected options, verification commands, and no-open-questions marker', () => {
    const md = renderDesignArtifact(artifact, 422);

    expect(md).toContain('## Design artifact (#422)');
    expect(md).toContain('### Restated problem');
    expect(md).toContain(artifact.restatedProblem);
    expect(md).toContain('### Approach');
    expect(md).toContain(artifact.approach.chosen);
    expect(md).toContain('**Separate file only** — BUILD would need an extra read.');
    expect(md).toContain('### Interfaces touched');
    expect(md).toContain('- packages/core/src/types/index.ts');
    expect(md).toContain('### Target types');
    expect(md).toContain('- `DesignArtifact` (packages/contracts/src/design.ts) — changed');
    expect(md).toContain('### Key signatures');
    expect(md).toContain(
      '- `renderDesignGrounding` (packages/core/src/design/index.ts) — `(artifact: DesignArtifact) => string`',
    );
    expect(md).toContain('### Call graph');
    expect(md).toContain('- buildPhase → renderDesignGrounding — grounding block for the worker prompt');
    expect(md).toContain('### Behavior contract');
    expect(md).toContain('- PLAN emits a validated design artifact.');
    expect(md).toContain('### Verification plan');
    expect(md).toContain('`bash scripts/verify.sh` — pass when: all checks green');
    expect(md).toContain('### Risk / blast radius');
    expect(md).toContain(artifact.riskBlastRadius);
    expect(md).toContain('### Open questions');
    expect(md).toContain('_None._');
  });

  it('flags open questions with a warning line and lists each one', () => {
    const withQuestions: DesignArtifact = { ...artifact, openQuestions: ['Is X intended?', 'What about Y?'] };
    const md = renderDesignArtifact(withQuestions, 422);

    expect(md).toContain('⚠️ 2 unresolved question(s) — review before merge.');
    expect(md).toContain('- Is X intended?');
    expect(md).toContain('- What about Y?');
  });

  it('renders _None recorded._ when there are no rejected approaches', () => {
    const withoutRejected: DesignArtifact = { ...artifact, approach: { ...artifact.approach, rejected: [] } };
    const md = renderDesignArtifact(withoutRejected, 422);

    expect(md).toContain('_None recorded._');
  });

  it('renders _None recorded._ for target types, signatures, and call graph when all three are empty', () => {
    const shallow: DesignArtifact = { ...artifact, targetTypes: [], signatures: [], callGraph: [] };
    const md = renderDesignArtifact(shallow, 422);

    expect(md).toContain('### Target types');
    expect(md).toContain('### Key signatures');
    expect(md).toContain('### Call graph');
    const noneRecordedCount = md.split('_None recorded._').length - 1;
    expect(noneRecordedCount).toBeGreaterThanOrEqual(3);
  });
});

describe('renderDesignGrounding', () => {
  it('returns "" when targetTypes, signatures, and callGraph are all empty', () => {
    const shallow: DesignArtifact = { ...artifact, targetTypes: [], signatures: [], callGraph: [] };
    expect(renderDesignGrounding(shallow)).toBe('');
  });

  it('renders the full grounding block with target types, signatures, and the call graph', () => {
    const grounding = renderDesignGrounding(artifact);

    expect(grounding).toContain('## Design grounding (from the frozen PLAN artifact)');
    expect(grounding).toContain('DesignArtifact');
    expect(grounding).toContain('(artifact: DesignArtifact) => string');
    expect(grounding).toContain('buildPhase → renderDesignGrounding');
  });

  it('renders a call edge without a note without a trailing dash', () => {
    const withoutNote: DesignArtifact = {
      ...artifact,
      callGraph: [{ from: 'a', to: 'b' }],
    };
    const grounding = renderDesignGrounding(withoutNote);

    expect(grounding).toContain('- a → b');
    expect(grounding).not.toContain('- a → b —');
  });

  it('renders only the target types section when signatures and callGraph are empty', () => {
    const onlyTargetTypes: DesignArtifact = { ...artifact, signatures: [], callGraph: [] };
    const grounding = renderDesignGrounding(onlyTargetTypes);

    expect(grounding).toContain('Target types — the types this change centers on:');
    expect(grounding).not.toContain('Key signatures — implement exactly these:');
    expect(grounding).not.toContain('Call graph sketch:');
  });

  it('renders only the call graph section when targetTypes and signatures are empty', () => {
    const onlyCallGraph: DesignArtifact = { ...artifact, targetTypes: [], signatures: [] };
    const grounding = renderDesignGrounding(onlyCallGraph);

    expect(grounding).not.toContain('Target types — the types this change centers on:');
    expect(grounding).not.toContain('Key signatures — implement exactly these:');
    expect(grounding).toContain('Call graph sketch:');
  });
});

describe('readDesignArtifact', () => {
  it('round-trips a written valid JSON artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'design-artifact-test-'));
    tempDirs.add(dir);
    const specPath = join(dir, 'issue-422.md');
    const { designJson } = specPaths(specPath);
    await writeFile(designJson, JSON.stringify(artifact, null, 2));

    await expect(readDesignArtifact(specPath)).resolves.toEqual(artifact);
  });

  it('returns null when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'design-artifact-test-'));
    tempDirs.add(dir);
    const specPath = join(dir, 'issue-422.md');

    await expect(readDesignArtifact(specPath)).resolves.toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'design-artifact-test-'));
    tempDirs.add(dir);
    const specPath = join(dir, 'issue-422.md');
    const { designJson } = specPaths(specPath);
    await writeFile(designJson, '{ not valid json');

    await expect(readDesignArtifact(specPath)).resolves.toBeNull();
  });

  it('returns null for schema-invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'design-artifact-test-'));
    tempDirs.add(dir);
    const specPath = join(dir, 'issue-422.md');
    const { designJson } = specPaths(specPath);
    await writeFile(designJson, JSON.stringify({ foo: 'bar' }));

    await expect(readDesignArtifact(specPath)).resolves.toBeNull();
  });
});
