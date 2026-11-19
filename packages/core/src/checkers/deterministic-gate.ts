import { extractFailingTestNames } from './baseline.js';
import { stripAnsi } from './command-log.js';
import { parseCommandCounts } from './command-output.js';
import type { DeterministicGateKind } from '../types/index.js';

export interface DeterministicGate {
  kind: DeterministicGateKind;
  lines: string[];
}

const LINT_DIAGNOSTIC = /^[×⚠!]\s+[\w@./-]+\([\w@./-]+\)/;

const GATE_MARKERS: readonly { kind: DeterministicGateKind; pattern: RegExp; when?: RegExp; ignore?: RegExp }[] = [
  { kind: 'coverage threshold', pattern: /Coverage for \w+ \([\d.]+%\) does not meet .*threshold/ },
  { kind: 'test-time budget', pattern: /^test-budget: FAIL\b/ },
  {
    kind: 'format',
    pattern: /Code style issues (?:were )?found\b|^\[warn\] \S/,
    when: /Code style issues (?:were )?found\b/,
  },
  {
    kind: 'lint',
    pattern:
      /^Found \d+ warnings? and [1-9]\d* errors?\b|^✖ \d+ problems? \([1-9]\d* errors?, \d+ warnings?\)|^ESLint found too many warnings\b|^Exceeded maximum number of warnings\b/,
    ignore: LINT_DIAGNOSTIC,
  },
  {
    kind: 'lint',
    pattern: /^Found [1-9]\d* warnings? and 0 errors?\b/,
    when: /--deny-warnings\b|--max-warnings[= ]0\b/,
    ignore: LINT_DIAGNOSTIC,
  },
  { kind: 'typecheck', pattern: /\berror TS\d+:/ },
];

const MAX_GATE_LINES = 12;
const MAX_UNCOVERED_ROWS = 30;

export function detectDeterministicGate(output: string): DeterministicGate | null {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const text = lines.join('\n');
  for (const { kind, pattern, when, ignore } of GATE_MARKERS) {
    if (when && !when.test(text)) continue;
    const matched = lines.filter((line) => pattern.test(line));
    if (matched.length === 0) continue;
    const rest = lines
      .filter((line) => !GATE_MARKERS.some((m) => m.pattern.test(line)) && !ignore?.test(line))
      .join('\n');
    if (extractFailingTestNames(rest).length > 0 || (parseCommandCounts(rest)?.failed ?? 0) > 0) return null;
    return { kind, lines: [...new Set(matched)].slice(0, MAX_GATE_LINES) };
  }
  return null;
}

const COVERAGE_ROW = /^( *)([^|]*?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*(.*?)\s*$/;

export function uncoveredChangedLines(output: string, changed: readonly string[]): string[] {
  const rows: string[] = [];
  let dir = '';
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const m = COVERAGE_ROW.exec(line);
    if (!m) continue;
    const [, indent = '', name = '', stmts, branch, funcs, pct, uncovered = ''] = m;
    if (name === 'All files') continue;
    if (indent.length <= 1) {
      dir = name;
      continue;
    }
    if (uncovered === '') continue;
    const path = dir === '' ? name : `${dir}/${name}`;
    const hit = changed.find((file) => file === path || file.endsWith(`/${path}`));
    if (hit === undefined) continue;
    rows.push(`${hit}: stmts ${stmts}%, branch ${branch}%, funcs ${funcs}%, lines ${pct}%; uncovered ${uncovered}`);
    if (rows.length >= MAX_UNCOVERED_ROWS) break;
  }
  return rows;
}

export function describeDeterministicGate(
  gate: DeterministicGate,
  uncovered: string[] | { unavailable: string },
): string {
  const parts = [
    `deterministic gate failed (${gate.kind}); no test failed, so this is not a flake. Fix the gap:`,
    ...gate.lines,
  ];
  if (gate.kind === 'coverage threshold') {
    if (Array.isArray(uncovered)) {
      parts.push(
        uncovered.length > 0
          ? `uncovered lines in changed files:\n${uncovered.join('\n')}`
          : 'no uncovered lines found for changed files in the coverage table',
      );
    } else {
      parts.push(`uncovered lines in changed files unavailable: ${uncovered.unavailable}`);
    }
  }
  return parts.join('\n');
}
