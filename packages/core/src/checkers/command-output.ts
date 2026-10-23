// src/checkers/command-output.ts — runner-output parsing shared by CHECK and summarizeCommandRun

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
  /** Hard cap on the summary length. Default 4000. */
  maxChars?: number;
  /** Path to the full log; rendered as the last line `full log: <path>`. */
  logPath?: string;
  /** Wall-clock duration; rendered in the header when given. */
  durationMs?: number;
}

export interface CommandRunCounts {
  format: 'vitest' | 'jest' | 'pytest' | 'tsc' | 'eslint';
  /** Rendered counts line, e.g. `2 failed | 300 passed`. */
  line: string;
  failed?: number;
  passed?: number;
  skipped?: number;
  errors?: number;
  warnings?: number;
  problems?: number;
}

const COUNT_PART = /(\d+) (failed|passed|skipped|errors?)\b/g;
const BLOCK_CHAR_CAP = 1000;
const TSC_ERROR_LINE = /error TS\d+:/;
const ESLINT_ERROR_LINE = /^\s+\d+:\d+\s+error\s/;
const ESLINT_FILE_LINE = /^(?:\/|[A-Za-z]:[\\/])/;

function countParts(text: string): { line: string; counts: Partial<CommandRunCounts> } | null {
  const parts: string[] = [];
  const counts: Partial<CommandRunCounts> = {};
  for (const m of text.matchAll(COUNT_PART)) {
    const n = Number(m[1]);
    const word = m[2]!;
    parts.push(`${n} ${word}`);
    if (word === 'failed') counts.failed = n;
    else if (word === 'passed') counts.passed = n;
    else if (word === 'skipped') counts.skipped = n;
    else counts.errors = n;
  }
  return parts.length > 0 ? { line: parts.join(' | '), counts } : null;
}

/** Pass/fail counts from vitest, jest, pytest, tsc or eslint output; null when no format matches. */
export function parseCommandCounts(output: string): CommandRunCounts | null {
  const vitest = /^\s*Tests\s+(.+?)(?:\s+\(\d+\))?\s*$/m.exec(output);
  const vitestParts = vitest ? countParts(vitest[1]!) : null;
  if (vitestParts) return { format: 'vitest', line: vitestParts.line, ...vitestParts.counts };

  const jest = /^Tests:\s+(.+?),\s*(\d+) total/m.exec(output);
  const jestParts = jest ? countParts(jest[1]!) : null;
  if (jestParts) return { format: 'jest', line: jestParts.line, ...jestParts.counts };

  const pytest = /^=+ (.*\d+ (?:failed|passed|skipped|errors?)\b.*?) in [\d.]+s\b.*=+\s*$/m.exec(output);
  const pytestParts = pytest ? countParts(pytest[1]!) : null;
  if (pytestParts) return { format: 'pytest', line: pytestParts.line, ...pytestParts.counts };

  const found = /^Found (\d+) errors?(?: in \d+ files?)?\.?/m.exec(output);
  const tscCount = found
    ? Number(found[1])
    : (output.match(/^\S.*\(\d+,\d+\): error TS\d+:|^\S+:\d+:\d+ - error TS\d+:/gm) ?? []).length;
  if (found || tscCount > 0) {
    return { format: 'tsc', line: `${tscCount} ${tscCount === 1 ? 'error' : 'errors'}`, errors: tscCount };
  }

  const eslint = /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(output);
  if (eslint) {
    return {
      format: 'eslint',
      line: `${eslint[1]} problems (${eslint[2]} errors, ${eslint[3]} warnings)`,
      problems: Number(eslint[1]),
      errors: Number(eslint[2]),
      warnings: Number(eslint[3]),
    };
  }
  return null;
}

/** Every failing test or error in the output, each with its following lines. */
function collectFailureBlocks(clean: string): string[] {
  const lines = clean.split(/\r?\n/);
  const vitestMode = lines.some((l) => !NPM_SCRIPT_ECHO.test(l) && FAILED_TEST_MARKERS[0]!.pattern.test(l));
  const markers = vitestMode ? FAILED_TEST_MARKERS.slice(0, 1) : FAILED_TEST_MARKERS;
  const markerLines = (line: string): number | null =>
    NPM_SCRIPT_ECHO.test(line) ? null : (markers.find((m) => m.pattern.test(line))?.lines ?? null);
  const isStart = (line: string): boolean =>
    markerLines(line) !== null || (!vitestMode && (TSC_ERROR_LINE.test(line) || ESLINT_ERROR_LINE.test(line)));

  const blocks: string[] = [];
  const seen = new Set<string>();
  let eslintFile = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!vitestMode && ESLINT_FILE_LINE.test(line) && !TSC_ERROR_LINE.test(line)) eslintFile = line.trim();
    if (!isStart(line)) continue;
    let head = line;
    let keep = markerLines(line);
    if (keep === null && !vitestMode && ESLINT_ERROR_LINE.test(line)) {
      head = eslintFile ? `${eslintFile}:${line.trim()}` : line.trim();
      keep = 1;
    } else if (keep === null) {
      keep = 5;
    }
    if (seen.has(head)) continue;
    seen.add(head);
    const body = [head];
    for (let j = i + 1; j < lines.length && body.length < keep; j++) {
      const next = lines[j]!;
      if (isStart(next)) break;
      // tsc and eslint continuation lines are indented; marker blocks take whatever follows.
      if (markerLines(line) === null && !/^\s/.test(next)) break;
      body.push(next);
    }
    const text = body.join('\n').trimEnd();
    blocks.push(text.length > BLOCK_CHAR_CAP ? `${text.slice(0, BLOCK_CHAR_CAP)}…` : text);
  }
  return blocks;
}

function renderHeader(result: CommandResult, options: SummarizeCommandRunOptions, maxChars: number): string {
  const suffix =
    ` — exit ${result.exitCode}` +
    (options.durationMs !== undefined ? ` in ${(options.durationMs / 1000).toFixed(1)}s` : '') +
    (result.timedOut ? ' (timed out)' : '');
  const quarter = Math.floor(maxChars / 4);
  let command = result.command.join(' ');
  if (command.length + 2 + suffix.length > quarter) {
    command = `${command.slice(0, Math.max(1, quarter - suffix.length - 3))}…`;
  }
  return `$ ${command}${suffix}`;
}

/** Short summary of a test, typecheck or lint run: header, counts, every failure with its lines,
 *  and the full-log path, never longer than `maxChars`. */
export function summarizeCommandRun(result: CommandResult, options: SummarizeCommandRunOptions = {}): string {
  const maxChars = options.maxChars ?? 4000;
  const clean = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const counts = parseCommandCounts(clean);
  const fixed = [renderHeader(result, options, maxChars), ...(counts ? [counts.line] : [])];
  const tailLine = options.logPath ? `full log: ${options.logPath}` : null;

  let blocks = collectFailureBlocks(clean);
  if (blocks.length === 0 && !result.ok) {
    const tail = outputTail(clean, 1500);
    if (tail) blocks = [tail];
  }

  const omission = (n: number): string => `… ${n} more failure${n === 1 ? '' : 's'} in the log`;
  const fixedLen = fixed.join('\n').length + (tailLine ? tailLine.length + 1 : 0);
  const kept: string[] = [];
  let used = fixedLen;
  for (const block of blocks) {
    const omitted = blocks.length - kept.length - 1;
    const total = used + block.length + 1 + (omitted > 0 ? omission(omitted).length + 1 : 0);
    if (total > maxChars) break;
    kept.push(block);
    used += block.length + 1;
  }
  const omitted = blocks.length - kept.length;

  const out = [...fixed, ...kept, ...(omitted > 0 ? [omission(omitted)] : []), ...(tailLine ? [tailLine] : [])].join(
    '\n',
  );
  if (out.length <= maxChars) return out;
  if (!tailLine || tailLine.length + 2 >= maxChars) return out.slice(0, maxChars);
  const room = maxChars - tailLine.length - 1;
  return `${fixed.join('\n').slice(0, room)}\n${tailLine}`;
}
