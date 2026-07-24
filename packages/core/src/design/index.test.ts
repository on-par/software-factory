import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DesignArtifact } from '../types/index.js';
import { designArtifactPaths, parseDesignArtifact, readDesignArtifact, renderDesignArtifact } from './index.js';

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
});

describe('designArtifactPaths', () => {
  it('derives .design.json and .design.md next to the spec', () => {
    expect(designArtifactPaths('/x/plans/issue-422.md')).toEqual({
      json: '/x/plans/issue-422.design.json',
      markdown: '/x/plans/issue-422.design.md',
    });
  });
});

describe('readDesignArtifact', () => {
  it('round-trips a written valid JSON artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'design-artifact-test-'));
    tempDirs.add(dir);
    const specPath = join(dir, 'issue-422.md');
    const { json } = designArtifactPaths(specPath);
    await writeFile(json, JSON.stringify(artifact, null, 2));

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
    const { json } = designArtifactPaths(specPath);
    await writeFile(json, '{ not valid json');

    await expect(readDesignArtifact(specPath)).resolves.toBeNull();
  });

  it('returns null for schema-invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'design-artifact-test-'));
    tempDirs.add(dir);
    const specPath = join(dir, 'issue-422.md');
    const { json } = designArtifactPaths(specPath);
    await writeFile(json, JSON.stringify({ foo: 'bar' }));

    await expect(readDesignArtifact(specPath)).resolves.toBeNull();
  });
});
