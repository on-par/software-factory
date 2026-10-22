import type { CommandResult } from '../utils/command-runner.js';

const COMMANDER_REQUIRED_OPTION_PATTERN = /^error: required option '.+' not specified$/gm;

/** Removes terminal escape sequences: SGR/CSI (`ESC[1;31m`, `ESC[2K`) and charset selects (`ESC(B`). */
export function stripAnsi(text: string): string {
  return text
    .split(String.fromCharCode(27))
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;?]*[A-Za-z]|^[()][A-Za-z0-9]/, '')))
    .join('');
}

export function stripIncidentalCommanderNoise(text: string): string {
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
export const NPM_SCRIPT_ECHO = /^> /;

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
  /** Where the full output was written; rendered as the last line `full log: <path>`. */
  logPath?: string;
  /** Wall-clock duration of the run, rendered as `duration: <n>ms` when given. */
  durationMs?: number;
}

const DEFAULT_SUMMARY_MAX_CHARS = 4000;
const TSC_ERROR_LINE = /^(.+)\((\d+),(\d+)\): error TS\d+:/;
const ESLINT_ROW = /^\s+\d+:\d+\s+(?:error|warning)\s/;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function testCounts(summary: string): string | null {
  const counts = new Map<string, number>();
  for (const m of summary.matchAll(/(\d+)\s+(failed|passed|skipped)/g)) counts.set(m[2] ?? '', Number(m[1]));
  if (counts.size === 0) return null;
  const parts = (['failed', 'passed', 'skipped'] as const).flatMap((k) => {
    const n = counts.get(k) ?? 0;
    return n > 0 || k !== 'skipped' ? [`${n} ${k}`] : [];
  });
  return `tests: ${parts.join(' | ')}`;
}

/** First recognised runner summary: vitest/jest, pytest, tsc, then eslint. */
function countsLine(lines: readonly string[], text: string): string | null {
  const vitestOrJest = /^\s*Tests:?\s+(.+)$/m.exec(text);
  const pytest = /^=+ (.+) in [\d.]+s.*=+\s*$/m.exec(text);
  const found = /\bFound (\d+) errors?\b/.exec(text);
  const eslint = /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(text);
  const fromRunner = testCounts(vitestOrJest?.[1] ?? '') ?? testCounts(pytest?.[1] ?? '');
  if (fromRunner) return fromRunner;
  if (found) return `tsc: ${plural(Number(found[1]), 'error')}`;
  const tscErrors = lines.filter((line) => TSC_ERROR_LINE.test(line)).length;
  if (tscErrors > 0) return `tsc: ${plural(tscErrors, 'error')}`;
  if (eslint) {
    return `eslint: ${plural(Number(eslint[1]), 'problem')} (${plural(Number(eslint[2]), 'error')}, ${plural(Number(eslint[3]), 'warning')})`;
  }
  return null;
}

/** How many lines of a block start at line `i`, or 0 when no block starts there. */
function blockLength(lines: readonly string[], i: number): number {
  const line = lines[i] ?? '';
  if (NPM_SCRIPT_ECHO.test(line)) return 0;
  const marker = FAILED_TEST_MARKERS.find(({ pattern }) => pattern.test(line));
  if (marker) return marker.lines;
  if (TSC_ERROR_LINE.test(line)) return 1;
  if (line !== '' && !/^\s/.test(line) && ESLINT_ROW.test(lines[i + 1] ?? '')) return 1;
  return 0;
}

function failureBlocks(lines: readonly string[]): string[] {
  const starts = lines.map((_, i) => blockLength(lines, i));
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const keep = starts[i] ?? 0;
    if (keep === 0) continue;
    const first = lines[i] ?? '';
    const isTsc = TSC_ERROR_LINE.test(first);
    const isEslint = !isTsc && keep === 1;
    let end = i + 1;
    if (isTsc) {
      while (end < lines.length && /^\s+\S/.test(lines[end] ?? '') && (starts[end] ?? 0) === 0) end++;
    } else if (isEslint) {
      while (end < lines.length && ESLINT_ROW.test(lines[end] ?? '')) end++;
    } else {
      while (end < lines.length && end < i + keep && (starts[end] ?? 0) === 0) end++;
    }
    const block = lines.slice(i, end).join('\n').trim();
    const key = first.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(block);
  }
  return blocks;
}

/** A short, hard-capped summary of a test, typecheck or lint run: command, exit code, duration,
 *  counts, every failing test or error with its lines, and the full-log path. Failure blocks are
 *  dropped from the end when they do not fit; the header and `full log:` line are always kept. */
export function summarizeCommandRun(result: CommandResult, options: SummarizeCommandRunOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  const text = `${stripAnsi(result.stdout)}\n${stripAnsi(result.stderr)}`;
  const lines = text.split(/\r?\n/);

  const meta = [`exit code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`];
  if (options.durationMs !== undefined) meta.push(`duration: ${Math.round(options.durationMs)}ms`);
  const footer = options.logPath === undefined ? [] : [`full log: ${options.logPath}`];

  let command = `$ ${result.command.join(' ')}`;
  const commandBudget = maxChars - [...meta, ...footer].join('\n').length - 1;
  if (command.length > commandBudget) command = `${command.slice(0, Math.max(commandBudget - 1, 0))}…`;
  const header = [command, ...meta];

  const assemble = (middle: readonly string[]): string => [...header, ...middle, ...footer].join('\n');
  const fits = (middle: readonly string[]): boolean => assemble(middle).length <= maxChars;

  const counts = countsLine(lines, text);
  const middle: string[] = counts !== null && fits([counts]) ? [counts] : [];

  const blocks = failureBlocks(lines);
  if (blocks.length === 0) {
    if (!result.ok) {
      const room = maxChars - assemble(middle).length - 1;
      const tail = room > 1 ? outputTail(text, room) : '';
      if (tail && fits([...middle, tail])) middle.push(tail);
    }
    return assemble(middle).slice(0, maxChars);
  }

  const everything = blocks.join('\n\n');
  if (fits([...middle, everything])) return assemble([...middle, everything]);

  const reserve = `… ${blocks.length} more failures in the log`;
  const included: string[] = [];
  for (const block of blocks) {
    const body = [...included, block].join('\n\n');
    if (!fits([...middle, body, reserve])) break;
    included.push(block);
  }
  const omitted = blocks.length - included.length;
  const omission = `… ${omitted} more failure${omitted === 1 ? '' : 's'} in the log`;
  const body = included.length > 0 ? [included.join('\n\n')] : [];
  const candidates = [[...middle, ...body, omission], [...body, omission], [...body]];
  return assemble(candidates.find(fits) ?? []).slice(0, maxChars);
}
