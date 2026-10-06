// src/reports/pr-body.ts — the PR description SHIP opens with. It leads with the intent of the
// change (the frozen spec's Goal, approach, and tests) so a reviewer sees why the change exists and
// how it solves the ticket before the file list. The diff stat stays, collapsed, at the end.

import type { CheckSummary } from '../types/index.js';

const SECTION_LIMIT = 4000;

export interface PrBodyInput {
  /** One line naming the work item, e.g. "Implements #23. Built by the Software Factory ...". */
  summaryLine: string;
  /** Frozen spec body with the frontmatter stripped; intent sections are omitted when absent. */
  specBody?: string;
  diffStat: string;
  checkSummary?: CheckSummary;
  /** Issue the PR closes; omitted for a non-github work source. */
  closes?: number;
}

export interface SpecIntent {
  goal?: string;
  approach?: string;
  tests?: string;
}

export function renderPrBody(input: PrBodyInput): string {
  const intent = input.specBody === undefined ? {} : extractSpecIntent(input.specBody);
  const verification = input.checkSummary
    ? `Checkers: ${input.checkSummary.passes} pass, ${input.checkSummary.failures} fail, ${input.checkSummary.skips} skip. `
    : '';

  return [
    section('Summary', input.summaryLine),
    intent.goal === undefined ? undefined : section('Why', intent.goal),
    intent.approach === undefined ? undefined : section('How', intent.approach),
    intent.tests === undefined ? undefined : section('Tests', intent.tests),
    section(
      'Verification',
      `${verification}This PR passed independent verification by checker agents before shipping.`,
    ),
    ['<details>', '<summary>Changed files</summary>', '', '```', input.diffStat, '```', '', '</details>'].join('\n'),
    input.closes === undefined ? undefined : `Closes #${input.closes}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n');
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
