// src/readiness/index.ts — Pure readiness scorer for GitHub issue bodies (#421).
// Scores an issue body against the required fields of the `.github/ISSUE_TEMPLATE/*.yml`
// form it matches, so issue quality can be measured and correlated against factory
// outcomes (see kpis/index.ts). No I/O — templates.test.ts keeps this coupled to the
// actual template files.

import { checkIssueSize } from './size.js';
import type { ReadinessInfo, ReadinessTemplate } from '../types/index.js';

export const FACTORY_TASK_REQUIRED_FIELDS = [
  'Problem statement',
  'In scope',
  'Out of scope',
  'Acceptance criteria',
  'Verification',
] as const;

export const FACTORY_BUG_REQUIRED_FIELDS = ['Observed behavior', 'Expected behavior', 'Reproduction steps'] as const;

export const EPIC_REQUIRED_FIELDS = ['Why', 'Children', 'Done when'] as const;

// Epics written in the "Scope / Success means" house style (see issue #1504) name the
// same three required fields under different labels, plus fold "Why" into an unheaded
// preamble paragraph rather than a section of its own. This maps each required epic
// field to the label-line/preamble synonym `findSection` should also accept.
export const EPIC_FIELD_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  Why: ['preamble'],
  Children: ['scope'],
  'Done when': ['success means'],
};

// A single required `\s` (not `\s+`) avoids a polynomial-backtracking pattern on
// attacker-controlled issue bodies (CodeQL js/polynomial-redos) — the label capture
// is `.trim()`-ed below, so any extra leading whitespace is stripped regardless.
const HEADING_RE = /^#{1,6}\s(.*)$/;
// A "label-line" heading: a short Title Case phrase alone on its own line, ending in a
// colon (e.g. "Scope:", "Success means:") — the heading style some hand-written epics
// use instead of ATX `#` headings. Opt-in only (see extractIssueSections's `labelLineHeadings`
// option) so it never fires for factory-task/factory-bug bodies, where a stray
// "Note:"-style line is prose, not a section break.
const LABEL_LINE_RE = /^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,3}):[ \t]*$/;
const CHECKBOX_RE = /^\s*-\s*\[[ xX]\]/m;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const EMPTY_PLACEHOLDERS = new Set(['_no response_', 'none']);
const PREAMBLE_KEY = 'preamble';

export interface ExtractIssueSectionsOptions {
  /** Also treat "Label:"-only lines as section headings, and capture any content
   *  before the first heading (of either style) under the `preamble` key. */
  labelLineHeadings?: boolean;
}

/** Markdown H1–H6 sections of an issue body, keyed by lowercased heading. With
 *  `labelLineHeadings`, also recognizes bare "Label:" lines as headings and captures
 *  unheaded leading content as a `preamble` section. */
export function extractIssueSections(body: string, options: ExtractIssueSectionsOptions = {}): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split('\n');

  let currentLabel: string | null = null;
  let currentContent: string[] = [];
  let inFence = false;
  let sawHeading = false;
  const preambleLines: string[] = [];

  const flush = () => {
    if (currentLabel !== null) {
      sections.set(currentLabel.toLowerCase(), currentContent.join('\n').trim());
    }
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      currentContent.push(line);
      continue;
    }

    const match = inFence
      ? null
      : (HEADING_RE.exec(line) ?? (options.labelLineHeadings ? LABEL_LINE_RE.exec(line) : null));
    if (match) {
      flush();
      currentLabel = match[1].trim();
      currentContent = [];
      sawHeading = true;
    } else if (currentLabel !== null) {
      currentContent.push(line);
    } else if (options.labelLineHeadings && !sawHeading) {
      preambleLines.push(line);
    }
  }
  flush();

  if (options.labelLineHeadings) {
    const preamble = preambleLines.join('\n').trim();
    if (preamble.length > 0) sections.set(PREAMBLE_KEY, preamble);
  }

  return sections;
}

function lookupSection(sections: Map<string, string>, field: string): string | undefined {
  const key = field.toLowerCase();
  const exact = sections.get(key);
  if (exact !== undefined) return exact;
  for (const [heading, content] of sections) {
    if (heading.startsWith(key)) return content;
  }
  return undefined;
}

/** Looks up a required field's section content by exact heading match first,
 *  falling back to a heading that starts with the field name (e.g. an issue's
 *  own "Acceptance criteria (Gherkin)" heading still satisfies a required
 *  "Acceptance criteria" field — the parenthetical is a style choice, not a
 *  missing section). Exact match wins on ambiguity (checked first). If given,
 *  `synonyms` are tried in order after the field itself comes up empty. */
export function findSection(
  sections: Map<string, string>,
  field: string,
  synonyms?: readonly string[],
): string | undefined {
  const direct = lookupSection(sections, field);
  if (direct !== undefined) return direct;
  if (synonyms === undefined) return undefined;
  for (const synonym of synonyms) {
    const value = lookupSection(sections, synonym);
    if (value !== undefined) return value;
  }
  return undefined;
}

function isPresent(content: string | undefined): boolean {
  if (content === undefined) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  return !EMPTY_PLACEHOLDERS.has(trimmed.toLowerCase());
}

const EPIC_TITLE_RE = /^(\[epic\]|epic:)/i;

function detectTemplate(title: string, sections: Map<string, string>): ReadinessTemplate {
  if (EPIC_TITLE_RE.test(title.trim()) || sections.has('children')) return 'epic';
  if (sections.has('observed behavior')) return 'factory-bug';
  return 'factory-task';
}

function requiredFieldsFor(template: ReadinessTemplate): readonly string[] {
  switch (template) {
    case 'epic':
      return EPIC_REQUIRED_FIELDS;
    case 'factory-bug':
      return FACTORY_BUG_REQUIRED_FIELDS;
    case 'factory-task':
      return FACTORY_TASK_REQUIRED_FIELDS;
  }
}

export function scoreIssueReadiness(input: { title: string; body: string }): ReadinessInfo {
  const body = input.body ?? '';
  const template = detectTemplate(input.title ?? '', extractIssueSections(body));
  // Label-line headings and preamble capture are opt-in and only applied once the body
  // is already known to be an epic, so a factory-task/factory-bug body with a stray
  // "Note:"-style line is never misread as introducing a section.
  const sections =
    template === 'epic' ? extractIssueSections(body, { labelLineHeadings: true }) : extractIssueSections(body);
  const requiredFields = requiredFieldsFor(template);
  const synonyms = template === 'epic' ? EPIC_FIELD_SYNONYMS : undefined;

  const missing: string[] = [];
  let present = 0;

  for (const field of requiredFields) {
    const content = findSection(sections, field, synonyms?.[field]);
    if (!isPresent(content)) {
      missing.push(field);
      continue;
    }
    if (field === 'Acceptance criteria' && !CHECKBOX_RE.test(content!)) {
      missing.push('Acceptance criteria (checkbox list)');
      continue;
    }
    present++;
  }

  const size =
    template === 'factory-task'
      ? checkIssueSize({
          inScope: findSection(sections, 'In scope') ?? '',
          acceptanceCriteria: findSection(sections, 'Acceptance criteria') ?? '',
        })
      : { sizeOk: true };

  return {
    template,
    score: present / requiredFields.length,
    pass: missing.length === 0,
    missing,
    sizeOk: size.sizeOk,
    ...(size.reason === undefined ? {} : { sizeReason: size.reason }),
  };
}
