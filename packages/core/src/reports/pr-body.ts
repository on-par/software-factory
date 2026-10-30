// src/reports/pr-body.ts — the PR description SHIP opens with. It is short: a 1-3 sentence summary
// of the frozen spec's Goal and approach, a one-line proof (checker counts, rework rounds), an
// optional risk line, the Closes / Part of line, and a configurable footer. It never lists changed
// files: the PR's own Files tab already shows them.

import { type WorkKey } from '../work/work-key.js';
import { defaultFactoryConfig } from '@on-par/factory-config';

import type { CheckSummary } from '../types/index.js';

const SECTION_LIMIT = 4000;
const WHAT_CHANGED_LIMIT = 600;
const WHAT_CHANGED_SENTENCES = 3;

/** Default last line of a PR body. */
export const PR_BODY_FOOTER = defaultFactoryConfig.pr.footer;

export interface PrBodyInput {
  /** Undefined uses the default footer; an empty string omits the footer. Otherwise rendered verbatim. */
  footer?: string;
  /** One line naming the work item, e.g. "Implements #23.". */
  summaryLine: string;
  /** Frozen spec body with the frontmatter stripped; intent sections are omitted when absent. */
  specBody?: string;
  checkSummary?: CheckSummary;
  /** Issue the PR closes; omitted for a non-github work source. */
  /** Rework rounds CHECK ran; undefined renders as 0. */
  reworkRounds?: number;
  /** The design artifact's Risk / blast radius; the Risk line is omitted when absent or blank. */
  risk?: string;
  closes?: WorkKey;
  /** Parent issue of a non-final ADR-0147 slice; renders `Part of #N` and never a closing keyword. */
  partOf?: WorkKey;
  /** Stack-mode (ADR-0161) stack-order line, rendered right after the Summary. */
  stackOrder?: string;
  /** Large-PR walkthrough markdown (#3623), rendered as a Walkthrough section; omitted when undefined. */
  walkthrough?: string;
  typescriptLines?: { net: number; nonTest: number } | 'unavailable';
}

const KEY = String.raw`[A-Z][A-Z0-9]{1,9}-\d+`;
const LEADING_KEY = new RegExp(String.raw`^\s*(?:[\[(]${KEY}[\])]|${KEY}(?=\s*(?:[:\-–—|]|$)))\s*[:\-–—|]?\s*`);
const TRAILING_KEY = new RegExp(String.raw`\s*[\[(]${KEY}[\])]\s*$`);
const LOCAL_BRIEF = /[^.\n]*\blocal[ -]brief\b[^.\n]*(?:\.|$)/gim;

/** A brief's title with its tracker-style id (`ARA-12: …`, `[ARA-12] …`, `… (ARA-12)`) and any "local brief"
 *  mention removed, for PR titles and bodies: reviewers cannot look those ids up. Plain words like UTF-8 stay. */
export function stripBriefIds(text: string): string {
  const stripped = text
    .replace(LOCAL_BRIEF, '')
    .replace(LEADING_KEY, '')
    .replace(TRAILING_KEY, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : 'Untitled change';
}

/** Summary line for brief-driven work: what it covers (the brief's title) and the open PR it builds on. Never the brief's id, digest or path. */
export function briefSummaryLine(title: string, basePr?: number): string {
  const what = stripBriefIds(title)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?…]+$/, '');
  return `${what}.${basePr === undefined ? '' : ` Builds on #${basePr}.`}`;
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
  const counts = input.typescriptLines;
  const lineCounts =
    counts === undefined
      ? ''
      : counts === 'unavailable'
        ? '\nTypeScript net lines: unavailable · TypeScript non-test net lines: unavailable'
        : `\nTypeScript net lines: ${counts.net} · TypeScript non-test net lines: ${counts.nonTest}`;
  const risk = input.risk?.replace(/\s+/g, ' ').trim();

  return [
    section('Summary', input.summaryLine),
    input.stackOrder,
    whatChanged === undefined ? undefined : section('What changed', whatChanged),
    section('Proof', proof + lineCounts),
    risk ? `**Risk:** ${risk}` : undefined,
    input.walkthrough ? section('Walkthrough', input.walkthrough) : undefined,
    input.closes !== undefined
      ? `Closes #${input.closes}`
      : input.partOf !== undefined
        ? `Part of #${input.partOf}`
        : undefined,
    input.footer === '' ? undefined : (input.footer ?? PR_BODY_FOOTER),
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
