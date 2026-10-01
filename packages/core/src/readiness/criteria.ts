// packages/core/src/readiness/criteria.ts — per-criterion grading for factory check (#1730). Pure — no I/O.
import { extractIssueSections, findSection } from './index.js';

export type CriterionGrade = 'structured' | 'unstructured' | 'empty';

export interface CriterionFinding {
  /** 1-based position among the section's checkbox items. */
  index: number;
  /** Criterion text with the `- [ ]` marker stripped and continuation lines joined by a space; '' when empty. */
  text: string;
  grade: CriterionGrade;
  /** False when the criterion has no Then clause and names no concrete value, command, file, or output. Always false for `empty`. */
  observable: boolean;
  /** 'no observable outcome' when grade is 'unstructured' and !observable; absent otherwise. */
  note?: string;
}

export interface CriteriaReport {
  findings: CriterionFinding[];
  /** null when the issue has no Verification section (scoreIssueReadiness already reports it missing). */
  verificationCommand: boolean | null;
  /** Human-readable blocking problems, in order; empty when pass. */
  problems: string[];
  pass: boolean;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const CHECKBOX_LINE_RE = /^ {0,3}[-*+] *\[[ xX]\](.*)$/;
const CONTINUATION_RE = /^\s+\S/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

const OBSERVABLE_RES: readonly RegExp[] = [
  /\bthen\b/i,
  /`[^`]+`/,
  /\d/,
  /"[^"]+"|'[^']+'/,
  /\b[\w.-]+\.[a-z]{1,5}\b/i,
  /\S+\/\S+/,
  /\b(exits?|prints?|outputs?|returns?|logs?|emits?|shows?|displays?|status|error)\b/i,
];

const COMMAND_WORDS = [
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'bash',
  'sh',
  'zsh',
  'git',
  'gh',
  'factory',
  'make',
  'docker',
  'curl',
  'python',
  'python3',
  'pip',
  'go',
  'cargo',
  'vitest',
  'tsc',
  'deno',
  'bun',
];
const COMMAND_LINE_RE = new RegExp(`^(?:${COMMAND_WORDS.join('|')})(?:\\s|$)`);

function gradeText(text: string): Omit<CriterionFinding, 'index' | 'text'> {
  if (text === '') return { grade: 'empty', observable: false };
  const when = /\bwhen\b/i.exec(text);
  const structured = when !== null && /\bthen\b/i.test(text.slice(when.index + when[0].length));
  const observable = OBSERVABLE_RES.some((re) => re.test(text));
  if (structured) return { grade: 'structured', observable };
  return observable
    ? { grade: 'unstructured', observable }
    : { grade: 'unstructured', observable, note: 'no observable outcome' };
}

export function assessAcceptanceCriteria(section: string): CriterionFinding[] {
  const texts: string[] = [];
  let inFence = false;
  let open = false;
  for (const line of section.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      open = false;
      continue;
    }
    if (inFence) continue;
    const box = CHECKBOX_LINE_RE.exec(line);
    if (box) {
      texts.push((box[1] ?? '').trim());
      open = true;
    } else if (open && CONTINUATION_RE.test(line) && !LIST_ITEM_RE.test(line)) {
      const last = texts.length - 1;
      texts[last] = `${texts[last]} ${line.trim()}`.trim();
    } else {
      open = false;
    }
  }
  return texts.map((text, i) => ({ index: i + 1, text, ...gradeText(text) }));
}

export function hasRunnableCommand(section: string): boolean {
  if (/`[^`\s][^`]*`/.test(section)) return true;
  let inFence = false;
  let fenceHasContent = false;
  for (const line of section.split('\n')) {
    if (FENCE_RE.test(line)) {
      if (inFence && fenceHasContent) return true;
      inFence = !inFence;
      fenceHasContent = false;
      continue;
    }
    if (inFence) {
      if (line.trim() !== '') fenceHasContent = true;
      continue;
    }
    const stripped = line
      .trim()
      .replace(/^(?:[-*+]\s*(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, '')
      .replace(/^\$\s+/, '');
    if (COMMAND_LINE_RE.test(stripped)) return true;
  }
  return false;
}

export function gradeIssueCriteria(body: string): CriteriaReport {
  const sections = extractIssueSections(body ?? '');
  const ac = findSection(sections, 'Acceptance criteria');
  const verification = findSection(sections, 'Verification');
  const findings = assessAcceptanceCriteria(ac ?? '');
  const verificationCommand = verification === undefined ? null : hasRunnableCommand(verification);
  const problems: string[] = [];
  if (ac !== undefined && findings.length === 0) problems.push('no acceptance criteria');
  for (const f of findings) if (f.grade === 'empty') problems.push(`criterion ${f.index} is empty`);
  if (verificationCommand === false) problems.push('Verification has no runnable command');
  return { findings, verificationCommand, problems, pass: problems.length === 0 };
}
