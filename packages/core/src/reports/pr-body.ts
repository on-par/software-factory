// src/reports/pr-body.ts — the PR description SHIP opens with. It is short: a 1-3 sentence summary
// of the frozen spec's Goal and approach, a one-line proof (checker counts, rework rounds), an
// optional risk line, the collapsed diff stat, the Closes / Part of line, and a fixed footer.

import type { CheckSummary } from '../types/index.js';

const SECTION_LIMIT = 4000;
const WHAT_CHANGED_LIMIT = 600;
const WHAT_CHANGED_SENTENCES = 3;

/** Fixed last line of every PR body. */
export const PR_BODY_FOOTER = 'This PR made possible by Software Factory.';

export interface PrBodyInput {
  /** One line naming the work item, e.g. "Implements #23.". */
  summaryLine: string;
  /** Frozen spec body with the frontmatter stripped; intent sections are omitted when absent. */
  specBody?: string;
  diffStat: string;
  checkSummary?: CheckSummary;
  /** Issue the PR closes; omitted for a non-github work source. */
  /** Rework rounds CHECK ran; undefined renders as 0. */
  reworkRounds?: number;
  /** The design artifact's Risk / blast radius; the Risk line is omitted when absent or blank. */
  risk?: string;
  closes?: number;
  /** Parent issue of a non-final ADR-0147 slice; renders `Part of #N` and never a closing keyword. */
  partOf?: number;
}

export interface SpecIntent {
  goal?: string;
  approach?: string;
  tests?: string;
}

export function renderPrBody(input: PrBodyInput): string {
  const intent = input.specBody === undefined ? {} : extractSpecIntent(input.specBody);
  const whatChanged = summarizeIntent(intent);
  const rounds = input.reworkRounds ?? 0;
  const proof = input.checkSummary
    ? `Checkers: ${input.checkSummary.passes} pass, ${input.checkSummary.failures} fail, ${input.checkSummary.skips} skip · Rework rounds: ${rounds}`
    : `Checkers: not run · Rework rounds: ${rounds}`;
  const risk = input.risk?.replace(/\s+/g, ' ').trim();

  return [
    section('Summary', input.summaryLine),
    whatChanged === undefined ? undefined : section('What changed', whatChanged),
    section('Proof', proof),
    risk ? `**Risk:** ${risk}` : undefined,
    ['<details>', '<summary>Changed files</summary>', '', '```', input.diffStat, '```', '', '</details>'].join('\n'),
    input.closes !== undefined
      ? `Closes #${input.closes}`
      : input.partOf !== undefined
        ? `Part of #${input.partOf}`
        : undefined,
    PR_BODY_FOOTER,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n');
}

/** A 1-3 sentence plain-prose digest of the goal and approach, cut at a sentence boundary within maxChars. */
export function summarizeIntent(intent: SpecIntent, maxChars = WHAT_CHANGED_LIMIT): string | undefined {
  const sources = [intent.goal, intent.approach].filter((text): text is string => text !== undefined);
  if (sources.length === 0) return undefined;
  const lines: string[] = [];
  let inFence = false;
  for (const line of sources.join('\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*#{1,6}\s/.test(line)) continue;
    lines.push(line.replace(/^\s*([-*+]|\d+\.)\s+/, ''));
  }
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;

  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map((piece) => (/[.!?…]$/.test(piece) ? piece : `${piece}.`));

  let result = '';
  for (const sentence of sentences.slice(0, WHAT_CHANGED_SENTENCES)) {
    const next = result === '' ? sentence : `${result} ${sentence}`;
    if (next.length > maxChars) break;
    result = next;
  }
  if (result !== '') return result;

  const head = (sentences[0] ?? text).slice(0, maxChars - 1);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd().replace(/[,;:]+$/, '')}…`;
}

/** Pulls the Goal, Files / approach, and Tests sections out of a frozen spec body. */
export function extractSpecIntent(specBody: string): SpecIntent {
  const sections = splitSections(specBody);
  return {
    goal: pick(sections, (heading) => heading === 'goal'),
    approach: pick(sections, (heading) => heading.includes('approach')),
    tests: pick(sections, (heading) => heading.startsWith('test')),
  };
}

function splitSections(body: string): Array<{ heading: string; text: string }> {
  const sections: Array<{ heading: string; text: string }> = [];
  let current: { heading: string; lines: string[] } | undefined;
  let inFence = false;
  for (const line of body.split('\n')) {
    // A `## ` line inside a fenced code block is content, not a section heading.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^## (.+)$/.exec(line);
    if (match) {
      if (current) sections.push({ heading: current.heading, text: current.lines.join('\n') });
      current = { heading: match[1].trim().toLowerCase(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, text: current.lines.join('\n') });
  return sections;
}

function pick(sections: Array<{ heading: string; text: string }>, matches: (heading: string) => boolean) {
  const text = sections.find((s) => matches(s.heading))?.text.trim();
  if (!text) return undefined;
  return text.length > SECTION_LIMIT ? `${text.slice(0, SECTION_LIMIT - 1).trimEnd()}…` : text;
}

function section(title: string, body: string): string {
  return `## ${title}\n${body}`;
}
