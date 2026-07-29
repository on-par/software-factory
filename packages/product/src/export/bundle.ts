// packages/product/src/export/bundle.ts — the handoff Design Bundle (#476).

import { adrSlug, createAdr, serializeAdr } from '@on-par/adr-kit';
import type { AdrDraft, CallEdge, DesignArtifact, Signature, TargetType } from '@on-par/contracts';

import { renderIntentDoc } from '../intent/index.js';
import type { ProposerArtifacts, ReadinessReport } from '../readiness/index.js';
import { renderReadinessReport } from '../readiness/index.js';
import { renderEpicIssue, renderStoryIssue } from './issues.js';

export interface BundleFile {
  path: string;
  content: string;
}

export interface DesignBundle {
  files: readonly BundleFile[];
}

function toFile(path: string, lines: readonly string[]): BundleFile {
  return { path, content: `${lines.join('\n')}\n` };
}

function issueFile(path: string, title: string, body: string): BundleFile {
  return toFile(path, [`# ${title}`, '', body]);
}

function padOrdinal(ordinal: number): string {
  return String(ordinal).padStart(2, '0');
}

function renderTargetTypes(targetTypes: readonly TargetType[]): string[] {
  if (targetTypes.length === 0) {
    return [];
  }
  return targetTypes.map((t) => `- ${t.name} (${t.kind}) — ${t.file}`);
}

function renderSignatures(signatures: readonly Signature[]): string[] {
  if (signatures.length === 0) {
    return [];
  }
  return signatures.map((s) => `- ${s.symbol} — ${s.signature}`);
}

function renderCallGraph(callGraph: readonly CallEdge[]): string[] {
  if (callGraph.length === 0) {
    return [];
  }
  return callGraph.map((edge) => `- ${edge.from} -> ${edge.to}${edge.note !== undefined ? `: ${edge.note}` : ''}`);
}

/** Renders an epic-level DesignArtifact into architecture.md's body lines. */
export function renderEpicArchitecture(artifact: DesignArtifact): string[] {
  const lines: string[] = ['# Epic architecture', '', '## Problem', artifact.restatedProblem];

  lines.push('', '## Approach', artifact.approach.chosen);
  if (artifact.approach.rejected.length > 0) {
    lines.push('', 'Rejected:');
    for (const rejected of artifact.approach.rejected) {
      lines.push(`- ${rejected.option} — ${rejected.reason}`);
    }
  }

  lines.push('', '## Interfaces touched');
  for (const item of artifact.interfacesTouched) {
    lines.push(`- ${item}`);
  }

  const targetTypeLines = renderTargetTypes(artifact.targetTypes);
  if (targetTypeLines.length > 0) {
    lines.push('', '## Target types', ...targetTypeLines);
  }

  const signatureLines = renderSignatures(artifact.signatures);
  if (signatureLines.length > 0) {
    lines.push('', '## Signatures', ...signatureLines);
  }

  const callGraphLines = renderCallGraph(artifact.callGraph);
  if (callGraphLines.length > 0) {
    lines.push('', '## Call graph', ...callGraphLines);
  }

  lines.push('', '## Behavior contract');
  for (const item of artifact.behaviorContract) {
    lines.push(`- ${item}`);
  }

  lines.push('', '## Verification');
  for (const step of artifact.verificationPlan) {
    lines.push(`- ${step.command} — passes when: ${step.passWhen}`);
  }

  lines.push('', '## Risk / blast radius', artifact.riskBlastRadius);

  lines.push('', '## Open questions');
  if (artifact.openQuestions.length === 0) {
    lines.push('None.');
  } else {
    for (const question of artifact.openQuestions) {
      lines.push(`- ${question}`);
    }
  }

  return lines;
}

/** Renders one proposed ADR draft into a bundle file, forced Status: Proposed, no number/date. */
export function adrDraftFile(draft: AdrDraft, ordinal: number): BundleFile {
  const adr = createAdr({
    title: draft.title,
    status: 'Proposed',
    context: draft.context,
    decision: draft.decision,
    consequences: draft.consequences,
    references: draft.references.map((r) => ({ text: r.text, url: r.url, marker: '-' })),
  });

  return { path: `adr-drafts/draft-${padOrdinal(ordinal)}-${adrSlug(draft.title)}.md`, content: serializeAdr(adr) };
}

/** Assembles the in-memory markdown handoff bundle from the proposer's artifacts and readiness report. */
export function buildDesignBundle(artifacts: ProposerArtifacts, report: ReadinessReport): DesignBundle {
  const files: BundleFile[] = [];

  if (artifacts.intent !== undefined) {
    files.push(toFile('intent.md', renderIntentDoc(artifacts.intent)));
  }

  if (artifacts.decomposition !== undefined) {
    const { epic, stories } = artifacts.decomposition;
    const epicPayload = renderEpicIssue(epic);
    files.push(issueFile('issues/epic.md', epicPayload.title, epicPayload.body));

    stories.forEach((story, i) => {
      const payload = renderStoryIssue(story);
      files.push(issueFile(`issues/story-${padOrdinal(i + 1)}.md`, payload.title, payload.body));
    });
  }

  if (artifacts.epicArchitecture !== undefined) {
    files.push(toFile('architecture.md', renderEpicArchitecture(artifacts.epicArchitecture)));
  }

  if (artifacts.adrConformance !== undefined) {
    artifacts.adrConformance.drafts.forEach((draft, i) => {
      files.push(adrDraftFile(draft, i + 1));
    });
  }

  files.push(toFile('readiness.md', renderReadinessReport(report)));

  return { files };
}
