// src/design/index.ts — Design artifact (#422): schema validation, rendering, and
// on-disk persistence for the structured design block PLAN writes into the frozen
// spec's YAML frontmatter and BUILD reads back off disk.

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { DesignArtifact } from '../types/index.js';

export const DesignArtifactSchema = z.object({
  restatedProblem: z.string().min(1),
  approach: z.object({
    chosen: z.string().min(1),
    rejected: z.array(z.object({ option: z.string().min(1), reason: z.string().min(1) })),
  }),
  interfacesTouched: z.array(z.string().min(1)),
  behaviorContract: z.array(z.string().min(1)),
  verificationPlan: z.array(z.object({ command: z.string().min(1), passWhen: z.string().min(1) })),
  riskBlastRadius: z.string().min(1),
  openQuestions: z.array(z.string()),
});

export function parseDesignArtifact(frontmatter: unknown): { artifact: DesignArtifact | null; errors: string[] } {
  if (typeof frontmatter !== 'object' || frontmatter === null || !('design' in frontmatter)) {
    return { artifact: null, errors: ['no design block in spec frontmatter'] };
  }

  const result = DesignArtifactSchema.safeParse((frontmatter as { design: unknown }).design);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return { artifact: null, errors };
  }

  return { artifact: result.data, errors: [] };
}

export function renderDesignArtifact(artifact: DesignArtifact, issue: number): string {
  const rejectedList =
    artifact.approach.rejected.length > 0
      ? artifact.approach.rejected.map((r) => `- **${r.option}** — ${r.reason}`).join('\n')
      : '_None recorded._';

  const openQuestionsBody =
    artifact.openQuestions.length > 0
      ? [
          `⚠️ ${artifact.openQuestions.length} unresolved question(s) — review before merge.`,
          '',
          artifact.openQuestions.map((q) => `- ${q}`).join('\n'),
        ].join('\n')
      : '_None._';

  return [
    `## Design artifact (#${issue})`,
    '',
    '### Restated problem',
    '',
    artifact.restatedProblem,
    '',
    '### Approach',
    '',
    artifact.approach.chosen,
    '',
    'Rejected:',
    '',
    rejectedList,
    '',
    '### Interfaces touched',
    '',
    artifact.interfacesTouched.map((i) => `- ${i}`).join('\n'),
    '',
    '### Behavior contract',
    '',
    artifact.behaviorContract.map((b) => `- ${b}`).join('\n'),
    '',
    '### Verification plan',
    '',
    artifact.verificationPlan.map((v) => `- \`${v.command}\` — pass when: ${v.passWhen}`).join('\n'),
    '',
    '### Risk / blast radius',
    '',
    artifact.riskBlastRadius,
    '',
    '### Open questions',
    '',
    openQuestionsBody,
    '',
  ].join('\n');
}

export function designArtifactPaths(specPath: string): { json: string; markdown: string } {
  const base = specPath.replace(/\.md$/, '');
  return { json: `${base}.design.json`, markdown: `${base}.design.md` };
}

export async function readDesignArtifact(specPath: string): Promise<DesignArtifact | null> {
  const { json } = designArtifactPaths(specPath);
  let raw: string;
  try {
    raw = await readFile(json, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = DesignArtifactSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
