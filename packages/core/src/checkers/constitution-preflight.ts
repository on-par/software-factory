// packages/core/src/checkers/constitution-preflight.ts — pure pre-PLAN validation of the
// constitution `checkers:` names (#2585). CHECK fails closed on unknown names; this catches them
// before any model call and locates the offending line in the constitution file.

import matter from 'gray-matter';
import { STANDARD_CHECKER_NAMES } from './index.js';

export interface UnknownConstitutionChecker {
  name: string;
  /** 1-based line in the constitution file, when the raw text was available and the name was found. */
  line?: number;
}

function isAllowed(value: unknown): boolean {
  return typeof value === 'string' && (STANDARD_CHECKER_NAMES.includes(value) || value.startsWith('custom_'));
}

function cleanItem(text: string): string {
  let t = text.replace(/\s+#.*$/, '').trim();
  const m = /^(['"])(.*)\1$/.exec(t);
  if (m) t = m[2];
  return t;
}

/** Candidate (name, 1-based line) pairs from the frontmatter `checkers:` list. */
function listCheckerLines(raw: string): Array<{ name: string; line: number }> {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return [];
  let end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) end = lines.length;
  const out: Array<{ name: string; line: number }> = [];
  for (let i = 1; i < end; i++) {
    const m = /^checkers\s*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[1].replace(/\s+#.*$/, '').trim();
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]$/, '');
      for (const part of inner.split(',')) out.push({ name: cleanItem(part), line: i + 1 });
      return out;
    }
    for (let j = i + 1; j < end; j++) {
      const l = lines[j];
      if (l.trim() === '' || l.trim().startsWith('#')) continue;
      const item = /^\s*-\s*(.*)$/.exec(l);
      if (!item) break;
      out.push({ name: cleanItem(item[1]), line: j + 1 });
    }
    return out;
  }
  return out;
}

export function findUnknownConstitutionCheckers(
  checkers: readonly unknown[],
  raw?: string,
): UnknownConstitutionChecker[] {
  const candidates = raw ? listCheckerLines(raw) : [];
  const used = new Set<number>();
  const problems: UnknownConstitutionChecker[] = [];
  for (const value of checkers) {
    if (isAllowed(value)) continue;
    const name = String(value);
    const hit = candidates.find((c) => c.name === name && !used.has(c.line));
    if (hit) {
      used.add(hit.line);
      problems.push({ name, line: hit.line });
    } else {
      problems.push({ name });
    }
  }
  return problems;
}

/** Unknown `checkers:` names in a constitution's raw text, parsed like ConstitutionLoader (#2611). Never throws. */
export function findUnknownCheckersInText(raw: string): UnknownConstitutionChecker[] {
  let checkers: unknown;
  try {
    checkers = matter(raw).data.checkers;
  } catch {
    return [];
  }
  return Array.isArray(checkers) ? findUnknownConstitutionCheckers(checkers, raw) : [];
}

export function formatUnknownCheckerMessage(displayPath: string, problem: UnknownConstitutionChecker): string {
  const where = problem.line ? `:${problem.line}` : '';
  return `${displayPath}${where}: unknown checker '${problem.name}'. Remove the line or use one of: ${[...STANDARD_CHECKER_NAMES, 'custom_*'].join(', ')}`;
}
