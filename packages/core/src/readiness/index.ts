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

// A single required `\s` (not `\s+`) avoids a polynomial-backtracking pattern on
// attacker-controlled issue bodies (CodeQL js/polynomial-redos) — the label capture
// is `.trim()`-ed below, so any extra leading whitespace is stripped regardless.
const HEADING_RE = /^#{1,6}\s(.*)$/;
const CHECKBOX_RE = /^\s*-\s*\[[ xX]\]/m;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const EMPTY_PLACEHOLDERS = new Set(['_no response_', 'none']);

/** Markdown H1–H6 sections of an issue body, keyed by lowercased heading. */
export function extractIssueSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split('\n');

  let currentLabel: string | null = null;
  let currentContent: string[] = [];
  let inFence = false;

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

    const match = inFence ? null : HEADING_RE.exec(line);
    if (match) {
      flush();
      currentLabel = match[1].trim();
      currentContent = [];
    } else if (currentLabel !== null) {
      currentContent.push(line);
    }
  }
  flush();

  return sections;
}

/** Looks up a required field's section content by exact heading match first,
 *  falling back to a heading that starts with the field name (e.g. an issue's
 *  own "Acceptance criteria (Gherkin)" heading still satisfies a required
 *  "Acceptance criteria" field — the parenthetical is a style choice, not a
 *  missing section). Exact match wins on ambiguity (checked first). */
export function findSection(sections: Map<string, string>, field: string): string | undefined {
  const key = field.toLowerCase();
  const exact = sections.get(key);
  if (exact !== undefined) return exact;
  for (const [heading, content] of sections) {
    if (heading.startsWith(key)) return content;
  }
  return undefined;
}

function isPresent(content: string | undefined): boolean {
  if (content === undefined) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  return !EMPTY_PLACEHOLDERS.has(trimmed.toLowerCase());
}

function detectTemplate(title: string, sections: Map<string, string>): ReadinessTemplate {
  if (/^\[epic\]/i.test(title.trim()) || sections.has('children')) return 'epic';
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
  const sections = extractIssueSections(body);
  const template = detectTemplate(input.title ?? '', sections);
  const requiredFields = requiredFieldsFor(template);

  const missing: string[] = [];
  let present = 0;

  for (const field of requiredFields) {
    const content = findSection(sections, field);
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
