// packages/product/src/architecture/context.ts — proposer design context: active ADRs + repo survey (#479).
import type { RepoContextReader } from '@on-par/repo-context';

import type { EpicAdr } from './adrs.js';
import { readActiveAdrs } from './adrs.js';
import type { RepoSurvey } from './survey.js';
import { surveyRepo } from './survey.js';

/** Cap on the Decision text quoted per ADR in the rendered block. */
const MAX_DECISION_CHARS = 300;

/** Everything the epic designer needs from the target repo — the `context` argument of designEpicArchitecture. */
export interface DesignContext {
  /** Accepted ADRs only — superseded/rejected/proposed are excluded by readActiveAdrs. */
  adrs: readonly EpicAdr[];
  survey: RepoSurvey;
}

export async function buildDesignContext(
  reader: RepoContextReader,
  opts?: { adrDir?: string; packagesDir?: string },
): Promise<DesignContext> {
  const [adrs, survey] = await Promise.all([
    readActiveAdrs(reader, { dir: opts?.adrDir }),
    surveyRepo(reader, { packagesDir: opts?.packagesDir, adrDir: opts?.adrDir }),
  ]);
  return { adrs, survey };
}

function condense(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Markdown lines for the 'active decisions' block of the design context. */
export function renderActiveDecisions(context: DesignContext): string[] {
  const lines: string[] = ['## Active decisions'];

  if (context.adrs.length === 0) {
    lines.push(
      context.survey.hasAdrHome
        ? 'None — the ADR home has no accepted decisions.'
        : 'None — no ADR home found in the target repo.',
    );
    return lines;
  }

  for (const adr of context.adrs) {
    lines.push(`- ${adr.label} — ${adr.title}`, `  Decision: ${condense(adr.decision, MAX_DECISION_CHARS)}`);
  }

  return lines;
}
