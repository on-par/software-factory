// src/design/index.ts — Design artifact (#422): schema validation, rendering, and
// on-disk persistence for the structured design block PLAN writes into the frozen
// spec's YAML frontmatter and BUILD reads back off disk.

import { readFile } from 'node:fs/promises';

import { DesignArtifactSchema } from '@on-par/contracts';

import type { DesignArtifact } from '../types/index.js';

export { DesignArtifactSchema };

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

function bulletList(items: string[]): string {
  return items.length > 0 ? items.join('\n') : '_None recorded._';
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
    '### Target types',
    '',
    bulletList(artifact.targetTypes.map((t) => `- \`${t.name}\` (${t.file}) — ${t.kind}`)),
    '',
    '### Key signatures',
    '',
    bulletList(artifact.signatures.map((s) => `- \`${s.symbol}\` (${s.file}) — \`${s.signature}\``)),
    '',
    '### Call graph',
    '',
    bulletList(artifact.callGraph.map((e) => `- ${e.from} → ${e.to}${e.note ? ` — ${e.note}` : ''}`)),
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

/**
 * Compact grounding block BUILD injects into the worker prompt (#480). Returns
 * '' when the artifact carries none of the deepened design fields, so a
 * pre-#480 artifact adds nothing to the prompt.
 */
export function renderDesignGrounding(artifact: DesignArtifact): string {
  const { targetTypes, signatures, callGraph } = artifact;
  if (targetTypes.length === 0 && signatures.length === 0 && callGraph.length === 0) return '';

  const lines: string[] = ['## Design grounding (from the frozen PLAN artifact)'];

  if (targetTypes.length > 0) {
    lines.push('', 'Target types — the types this change centers on:', '');
    lines.push(...targetTypes.map((t) => `- \`${t.name}\` in ${t.file} (${t.kind})`));
  }
  if (signatures.length > 0) {
    lines.push('', 'Key signatures — implement exactly these:', '');
    lines.push(...signatures.map((s) => `- \`${s.symbol}\` in ${s.file} — \`${s.signature}\``));
  }
  if (callGraph.length > 0) {
    lines.push('', 'Call graph sketch:', '');
    lines.push(...callGraph.map((e) => `- ${e.from} → ${e.to}${e.note ? ` — ${e.note}` : ''}`));
  }

  lines.push(
    '',
    'These are the frozen plan’s decisions — follow them. If the checkout contradicts one, ' +
      'say so in your commit message instead of silently diverging.',
  );

  return lines.join('\n');
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
