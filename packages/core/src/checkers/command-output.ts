// src/checkers/command-output.ts — bounded summaries of command output (CHECK failure evidence and summarizeCommandRun)

import type { CommandResult } from '../utils/command-runner.js';
import { stripAnsi } from './command-log.js';

const COMMANDER_REQUIRED_OPTION_PATTERN = /^error: required option '.+' not specified$/gm;

function stripIncidentalCommanderNoise(text: string): string {
  return text
    .replace(COMMANDER_REQUIRED_OPTION_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/** Where a failing test announces itself, per runner, and how many lines of its message to keep.
 *  Checked in order, so a vitest FAIL line wins over a vitest suite summary. */
export const FAILED_TEST_MARKERS: readonly { pattern: RegExp; lines: number }[] = [
  // vitest: " FAIL  file > suite > test"
  { pattern: /\bFAIL\s+.+\s+>/, lines: 12 },
  // vitest suite summary: " > file (6 tests | 1 failed) 15ms"
  { pattern: /^\s*\S+\s+.+\(\d+ tests?\s+\|\s+\d+ failed\)/, lines: 8 },
  // .NET Microsoft.Testing.Platform: "failed Namespace.Class.Test (46ms)"
  { pattern: /^\s*failed\s+\S+\s+\((?:\d+(?:\.\d+)?\s*(?:ms|s|m)\s*)+\)\s*$/, lines: 12 },
  // .NET VSTest: "  Failed Namespace.Class.Test [46 ms]"
  { pattern: /^\s*Failed\s+\S+\s+\[[^\]]+\]\s*$/, lines: 12 },
  // go test: "--- FAIL: TestName (0.00s)"
  { pattern: /^\s*--- FAIL:\s+\S+/, lines: 12 },
  // pytest short summary: "FAILED tests/test_x.py::test_y - AssertionError"
  { pattern: /^FAILED\s+\S+::\S+/, lines: 8 },
];

/** npm echoes the script it runs at column 0 (`> node -e "..."`); that text is the command, not its output. */
const NPM_SCRIPT_ECHO = /^> /;

export function extractFailedTestEvidence(output: string): string | null {
  const lines = stripAnsi(output).split(/\r?\n/);
  for (const { pattern, lines: keep } of FAILED_TEST_MARKERS) {
    const start = lines.findIndex((line) => !NPM_SCRIPT_ECHO.test(line) && pattern.test(line));
    if (start >= 0) {
      return lines
        .slice(start, start + keep)
        .join('\n')
        .trim();
    }
  }
  return null;
}

/** Bounded tail of command output. Runners print banners first and failures and summaries
 *  last, so a head slice keeps the banner and drops the error. */
export function outputTail(text: string, maxChars: number): string {
  const clean = stripAnsi(text).trim();
  if (clean.length <= maxChars) return clean;
  const tail = clean.slice(-maxChars);
  // Drop the partial first line, unless that would throw away most of the tail.
  const lineStart = tail.indexOf('\n');
  return `…${lineStart >= 0 && lineStart < maxChars / 2 ? tail.slice(lineStart + 1) : tail}`;
}

export function describeCommandFailureTail(r: CommandResult, maxChars: number): string {
  const output = r.stderr.trim() !== '' ? r.stderr : r.stdout;
  return outputTail(output, maxChars) || (r.timedOut ? 'timed out' : `exit code ${r.exitCode}`);
}

/** Failed-test evidence when a known runner format is found on stdout or stderr, else the output's tail. */
export function describeTestFailure(r: CommandResult, maxChars: number): string {
  const stdoutEvidence = extractFailedTestEvidence(r.stdout);
  if (stdoutEvidence) {
    const stderr = stripIncidentalCommanderNoise(stripAnsi(r.stderr));
    return (stderr ? `${stdoutEvidence}\nstderr:\n${stderr}` : stdoutEvidence).slice(0, maxChars);
  }

  const stderrEvidence = extractFailedTestEvidence(r.stderr);
  if (stderrEvidence) return stderrEvidence.slice(0, maxChars);

  return describeCommandFailureTail(r, maxChars);
}

export interface CommandRunSummaryOptions {
  /** Hard cap on the returned string's length. Default 4000. */
  maxChars?: number;
  /** Where the full output was written; rendered as the last line `full log: <path>`. */
  logPath?: string;
  /** Wall-clock run time; CommandResult carries none, so the caller passes it. */
  durationMs?: number;
}

export const DEFAULT_SUMMARY_MAX_CHARS = 4000;

const TSC_PAREN_ERROR = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;
const TSC_PRETTY_ERROR = /^(.+?):(\d+):(\d+) - error TS\d+:/;
const TSC_FOUND = /Found (\d+) errors?/;
const ESLINT_SUMMARY = /✖\s+(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/;
const ESLINT_ERROR_ROW = /^\s+(\d+):(\d+)\s+error\s+(.*)$/;

function isTscError(line: string): boolean {
  return TSC_PAREN_ERROR.test(line) || TSC_PRETTY_ERROR.test(line);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function countOf(text: string, word: string): number {
  const m = new RegExp(`(\\d+) ${word}`).exec(text);
  return m ? Number(m[1]) : 0;
}

/** `tests: 2 failed | 300 passed | 1 skipped`, zero parts omitted; null when every count is zero. */
function renderTestCounts(text: string): string | null {
  const parts = [
    [countOf(text, 'failed'), 'failed'],
    [countOf(text, 'passed'), 'passed'],
    [countOf(text, 'skipped'), 'skipped'],
  ]
    .filter(([n]) => n !== 0)
    .map(([n, label]) => `${n} ${label}`);
  return parts.length > 0 ? `tests: ${parts.join(' | ')}` : null;
}

/** Ordered per-format count parsers; the first that recognizes the output wins. Each
 *  scans from the end so the runner's final summary line is the one used. */
const COUNT_PARSERS: readonly ((lines: readonly string[]) => string | null)[] = [
  (lines) => testSummaryCounts(lines, /^\s*Tests\s+(.+?)\s+\(\d+\)\s*$/),
  (lines) => testSummaryCounts(lines, /^Tests:\s+(.+?),\s+\d+ total/),
  (lines) => testSummaryCounts(lines, /^=+\s+(.*\b(?:passed|failed)\b.*?)\s+in\s+[\d.]+s.*=+\s*$/),
  (lines) => {
    const errors = lines.filter(isTscError).length;
    const found = lastMatch(lines, TSC_FOUND);
    const n = found ? Number(found[1]) : errors;
    return n > 0 ? `typecheck: ${plural(n, 'error')}` : null;
  },
  (lines) => {
    const m = lastMatch(lines, ESLINT_SUMMARY);
    return m
      ? `lint: ${plural(Number(m[1]), 'problem')} (${plural(Number(m[2]), 'error')}, ${plural(Number(m[3]), 'warning')})`
      : null;
  },
];

function lastMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = pattern.exec(lines[i] ?? '');
    if (m) return m;
  }
  return null;
}

function testSummaryCounts(lines: readonly string[], pattern: RegExp): string | null {
  const m = lastMatch(lines, pattern);
  return m ? renderTestCounts(m[1] ?? '') : null;
}

/** Every failing-test block: all lines matching the first marker that matches anywhere. */
function testFailureBlocks(lines: readonly string[]): string[] {
  for (const { pattern, lines: keep } of FAILED_TEST_MARKERS) {
    const starts = lines.flatMap((line, i) => (pattern.test(line) ? [i] : []));
    if (starts.length === 0) continue;
    return starts.map((start) => {
      let end = start + 1;
      while (end < lines.length && end < start + keep && !pattern.test(lines[end] ?? '')) end++;
      return lines.slice(start, end).join('\n').trim();
    });
  }
  return [];
}

function eslintErrorBlocks(lines: readonly string[]): string[] {
  const blocks: string[] = [];
  let file = '';
  for (const line of lines) {
    const row = ESLINT_ERROR_ROW.exec(line);
    if (row) {
      if (file) blocks.push(`${file}:${row[1]}:${row[2]} error ${row[3]}`);
    } else if (line.trim() !== '' && !/^\s/.test(line) && !line.includes('✖')) {
      file = line.trim();
    }
  }
  return blocks;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** A bounded summary of a test, typecheck or lint run: header, counts, every failure, and the log path.
 *  The returned string never exceeds `maxChars`, whatever the input size. */
export function summarizeCommandRun(result: CommandResult, options: CommandRunSummaryOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  const lines = stripAnsi(`${result.stdout}\n${result.stderr}`)
    .split(/\r?\n/)
    .filter((line) => !NPM_SCRIPT_ECHO.test(line));

  const tail = options.logPath ? [`full log: ${options.logPath}`] : [];
  const tailLength = tail.length > 0 ? (tail[0]?.length ?? 0) + 1 : 0;
  const duration = options.durationMs === undefined ? '' : ` in ${(options.durationMs / 1000).toFixed(1)}s`;
  const header = clip(
    `$ ${result.command.join(' ')} — exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${duration}`,
    Math.max(1, maxChars - tailLength),
  );
  const counts = COUNT_PARSERS.map((parse) => parse(lines)).find((c) => c !== null) ?? null;
  const fixed = counts ? [header, counts] : [header];

  const blockCap = Math.floor(maxChars / 4);
  let blocks = [...testFailureBlocks(lines), ...lines.filter(isTscError), ...eslintErrorBlocks(lines)]
    .filter((block) => block !== '')
    .map((block) => clip(block, blockCap));
  blocks = [...new Set(blocks)];
  if (blocks.length === 0 && !result.ok) {
    const budget = maxChars - fixed.join('\n').length - tailLength - 1;
    const fallback = budget > 0 ? describeCommandFailureTail(result, budget) : '';
    if (fallback) blocks = [fallback];
  }

  const omission = (n: number): string[] => (n > 0 ? [`… ${n} more failures in the log`] : []);
  const kept: string[] = [];
  for (const block of blocks) {
    const candidate = [...fixed, ...kept, block, ...omission(blocks.length - kept.length - 1), ...tail];
    if (candidate.join('\n').length > maxChars) break;
    kept.push(block);
  }
  let out = [...fixed, ...kept, ...omission(blocks.length - kept.length), ...tail].join('\n');
  if (out.length > maxChars) out = [...fixed, ...kept, ...tail].join('\n');
  // The cap is a hard invariant; the header is clipped to leave room for the log line, so this guard is rarely reached.
  return out.length <= maxChars ? out : out.slice(0, maxChars);
}
