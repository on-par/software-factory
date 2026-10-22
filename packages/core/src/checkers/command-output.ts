// src/checkers/command-output.ts — parse and summarize checker/agent command output (#3328)

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
  // vitest coverage thresholds: "ERROR: Coverage for statements (96.83%) does not meet "glob" threshold (96.9%)"
  { pattern: /Coverage for \w+ \([\d.]+%\) does not meet .*threshold/, lines: 8 },
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

export interface SummarizeCommandRunOptions {
  /** Hard cap on the returned summary length. Default 4000. */
  maxChars?: number;
  /** Path of the full output log; rendered as the last line `full log: <path>`. */
  logPath?: string;
}

export interface CommandRunCounts {
  format: 'vitest' | 'jest' | 'pytest' | 'tsc' | 'eslint';
  /** Rendered counts text, e.g. `2 failed | 300 passed`, `3 errors`, `4 problems (3 errors, 1 warning)`. */
  text: string;
  failed?: number;
  passed?: number;
  skipped?: number;
  errors?: number;
  warnings?: number;
  problems?: number;
}

const DEFAULT_SUMMARY_CHARS = 4000;
const TSC_PAREN_ERROR = /^\S.*\(\d+,\d+\): error TS\d+:/;
const TSC_COLON_ERROR = /^\S+:\d+:\d+ - error TS\d+:/;
const ESLINT_ROW = /^\s+\d+:\d+\s+(error|warning)\s+/;
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$|\.vue$|\.svelte$/;

function lastMatch(output: string, pattern: RegExp): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null;
  for (const m of output.matchAll(pattern)) last = m;
  return last;
}

function runnerCounts(format: 'vitest' | 'jest' | 'pytest', list: string): CommandRunCounts {
  const counts: CommandRunCounts = { format, text: '' };
  const parts: string[] = [];
  for (const key of ['failed', 'passed', 'skipped'] as const) {
    const m = new RegExp(`(\\d+) ${key}\\b`).exec(list);
    if (m) {
      counts[key] = Number(m[1]);
      parts.push(`${m[1]} ${key}`);
    }
  }
  counts.text = parts.join(' | ');
  return counts;
}

/** Pass/fail/skip counts from a recognized vitest, jest, pytest, tsc or eslint summary, or null. Last summary wins. */
export function parseCommandRunCounts(output: string): CommandRunCounts | null {
  const vitest = lastMatch(output, /^[ \t]*Tests[ \t]+(.+?)[ \t]*\((\d+)\)[ \t]*$/gm);
  if (vitest) return runnerCounts('vitest', vitest[1]);
  const jest = lastMatch(output, /^Tests:[ \t]+(.+?),[ \t]*(\d+) total[ \t]*$/gm);
  if (jest) return runnerCounts('jest', jest[1]);
  const pytest = lastMatch(
    output,
    /^=+[ \t]*(.*?\b(?:passed|failed|error|errors)\b.*?)[ \t]+in[ \t]+[\d.]+s.*=+[ \t]*$/gm,
  );
  if (pytest) return runnerCounts('pytest', pytest[1]);
  const found = lastMatch(output, /^Found (\d+) errors?(?: in \d+ files?)?\.?[ \t]*$/gm);
  if (found)
    return { format: 'tsc', errors: Number(found[1]), text: `${found[1]} ${found[1] === '1' ? 'error' : 'errors'}` };
  const tscLines = output.split(/\r?\n/).filter((l) => TSC_PAREN_ERROR.test(l) || TSC_COLON_ERROR.test(l)).length;
  if (tscLines > 0)
    return { format: 'tsc', errors: tscLines, text: `${tscLines} ${tscLines === 1 ? 'error' : 'errors'}` };
  const eslint = lastMatch(output, /^✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/gm);
  if (eslint) {
    const [, problems, errors, warnings] = eslint;
    const tail = eslint[0].slice(eslint[0].indexOf('('));
    return {
      format: 'eslint',
      problems: Number(problems),
      errors: Number(errors),
      warnings: Number(warnings),
      text: `${problems} ${problems === '1' ? 'problem' : 'problems'} ${tail}`,
    };
  }
  return null;
}

function markerBudget(line: string): number | null {
  const marker = FAILED_TEST_MARKERS.find(({ pattern }) => pattern.test(line));
  return marker ? marker.lines : null;
}

function looksLikeFileHeading(line: string): boolean {
  return /^\S/.test(line) && !line.startsWith('✖') && (/[/\\]/.test(line) || SOURCE_EXTENSION.test(line.trim()));
}

function collectFailureBlocks(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const blocks: string[] = [];
  let file = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (NPM_SCRIPT_ECHO.test(line)) {
      i += 1;
      continue;
    }
    const budget = markerBudget(line);
    if (budget !== null) {
      let end = i + 1;
      while (end < i + budget && end < lines.length && markerBudget(lines[end]) === null) end += 1;
      blocks.push(lines.slice(i, end).join('\n').trimEnd());
      i = end;
    } else if (TSC_PAREN_ERROR.test(line) || TSC_COLON_ERROR.test(line)) {
      let end = i + 1;
      while (end < lines.length && end <= i + 4 && /^\s+\S/.test(lines[end])) end += 1;
      blocks.push(lines.slice(i, end).join('\n'));
      i = end;
    } else {
      if (ESLINT_ROW.test(line)) blocks.push(`${file}:${line.trim()}`);
      else if (looksLikeFileHeading(line)) file = line.trim();
      i += 1;
    }
  }
  return blocks;
}

/** Dedupe by first line, keeping the longer block at the first occurrence's position (vitest prints each failure twice). */
function dedupeBlocks(blocks: string[]): string[] {
  const byFirstLine = new Map<string, string>();
  for (const block of blocks) {
    const key = block.split('\n')[0].trim();
    const prior = byFirstLine.get(key);
    if (prior === undefined || block.length > prior.length) byFirstLine.set(key, block);
  }
  return [...byFirstLine.values()];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

function omittedLine(count: number): string {
  return `… ${count} more failures in the log`;
}

/** Short, bounded summary of a command run: header, counts, every failing test or error with its lines, and the log path. */
export function summarizeCommandRun(
  result: CommandResult & { durationMs?: number },
  options: SummarizeCommandRunOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_SUMMARY_CHARS;
  const timedOut = result.timedOut ? ' (timed out)' : '';
  const duration = result.durationMs !== undefined ? ` in ${formatDuration(result.durationMs)}` : '';
  const header = `$ ${result.command.join(' ')} — exit ${result.exitCode}${timedOut}${duration}`;
  const footer = options.logPath !== undefined ? `\nfull log: ${options.logPath}` : '';

  if (header.length + footer.length > maxChars) {
    const room = Math.max(0, maxChars - footer.length);
    const cutHeader = room > 0 ? `${header.slice(0, room - 1)}…` : '';
    return `${cutHeader}${footer}`.slice(-maxChars);
  }

  const stdout = stripAnsi(result.stdout);
  const stderr = stripAnsi(result.stderr);
  const counts = parseCommandRunCounts(`${stdout}\n${stderr}`);
  const top = counts
    ? `${header}\n${counts.format === 'tsc' || counts.format === 'eslint' ? counts.format : 'tests'}: ${counts.text}`
    : header;
  const base = top.length + footer.length;

  let blocks = dedupeBlocks([...collectFailureBlocks(stdout), ...collectFailureBlocks(stderr)]);
  if (blocks.length === 0 && result.exitCode !== 0) {
    const tail = outputTail(
      result.stdout.trim() !== '' ? result.stdout : result.stderr,
      Math.max(0, maxChars - base - 5),
    );
    if (tail) blocks = [tail];
  }

  const reserve = 2 + omittedLine(blocks.length).length;
  const shown: string[] = [];
  let used = 0;
  for (const [k, block] of blocks.entries()) {
    const needsReserve = k < blocks.length - 1 ? reserve : 0;
    if (base + used + 2 + block.length + needsReserve <= maxChars) {
      shown.push(block);
      used += 2 + block.length;
    } else {
      const room = maxChars - base - used - 2 - reserve;
      if (shown.length === 0 && room > 1) {
        shown.push(`${block.slice(0, room - 1)}…`);
      }
      break;
    }
  }

  const omitted = blocks.length - shown.length;
  const sections = [top, ...shown, ...(omitted > 0 ? [omittedLine(omitted)] : [])];
  const out = `${sections.join('\n\n')}${footer}`;
  if (out.length <= maxChars) return out;
  return `${top}${omitted > 0 ? `\n\n${omittedLine(omitted)}` : ''}${footer}`.slice(0, maxChars);
}
