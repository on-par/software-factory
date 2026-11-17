import { StringDecoder } from 'node:string_decoder';

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

const VITEST_FAIL_LINE = { pattern: /\bFAIL\s+.+\s+>/, lines: 12 };
const VITEST_SUITE_SUMMARY = { pattern: /^\s*\S+\s+.+\(\d+ tests?\s+\|\s+\d+ failed\)/, lines: 8 };
const DOTNET_TESTING_PLATFORM_FAILED = {
  pattern: /^\s*failed\s+\S+\s+\((?:\d+(?:\.\d+)?\s*(?:ms|s|m)\s*)+\)\s*$/,
  lines: 12,
};
const DOTNET_VSTEST_FAILED = { pattern: /^\s*Failed\s+\S+\s+\[[^\]]+\]\s*$/, lines: 12 };
const GO_TEST_FAIL = { pattern: /^\s*--- FAIL:\s+\S+/, lines: 12 };
const PYTEST_SHORT_SUMMARY_FAILED = { pattern: /^FAILED\s+\S+::\S+/, lines: 8 };
const VITEST_COVERAGE_THRESHOLD_MISSED = {
  pattern: /Coverage for \w+ \([\d.]+%\) does not meet .*threshold/,
  lines: 8,
};

export const FAILED_TEST_MARKERS: readonly { pattern: RegExp; lines: number }[] = [
  VITEST_FAIL_LINE,
  VITEST_SUITE_SUMMARY,
  DOTNET_TESTING_PLATFORM_FAILED,
  DOTNET_VSTEST_FAILED,
  GO_TEST_FAIL,
  PYTEST_SHORT_SUMMARY_FAILED,
  VITEST_COVERAGE_THRESHOLD_MISSED,
];

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

export function outputTail(text: string, maxChars: number): string {
  const clean = stripAnsi(text).trim();
  if (clean.length <= maxChars) return clean;
  const tail = clean.slice(-maxChars);
  const lineStart = tail.indexOf('\n');
  return `…${lineStart >= 0 && lineStart < maxChars / 2 ? tail.slice(lineStart + 1) : tail}`;
}

const VITEST_TEST_CONSOLE_HEADER = /^(?:stdout|stderr) \| \S/;

export function stripTestConsoleBlocks(text: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    if (VITEST_TEST_CONSOLE_HEADER.test(line)) inBlock = true;
    else if (inBlock) inBlock = line.trim() !== '';
    else kept.push(line);
  }
  return kept.join('\n');
}

export function describeCommandFailureTail(r: CommandResult, maxChars: number): string {
  const stderr = stripTestConsoleBlocks(r.stderr);
  const output = stderr.trim() !== '' ? stderr : stripTestConsoleBlocks(r.stdout);
  return outputTail(output, maxChars) || (r.timedOut ? 'timed out' : `exit code ${r.exitCode}`);
}

export const COMBINED_TAIL_CHARS = 64 * 1024;

export function combinedOutputTail(maxChars: number = COMBINED_TAIL_CHARS): {
  onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
  text: () => string;
} {
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  let text = '';
  return {
    onOutput: (stream, chunk) => {
      text += decoders[stream].write(chunk);
      if (text.length > 2 * maxChars) text = text.slice(-maxChars);
    },
    text: () => text.slice(-maxChars),
  };
}

export function describeTestFailure(r: CommandResult, maxChars: number, combined?: string): string {
  const stderr = stripTestConsoleBlocks(r.stderr);
  const stderrEvidence = extractFailedTestEvidence(stderr);
  const stdoutEvidence = extractFailedTestEvidence(stripTestConsoleBlocks(r.stdout));
  if (stdoutEvidence) {
    const rest = stripIncidentalCommanderNoise(stderrEvidence ?? stderr);
    return (rest ? `${stdoutEvidence}\nstderr:\n${rest}` : stdoutEvidence).slice(0, maxChars);
  }

  if (stderrEvidence) return stderrEvidence.slice(0, maxChars);

  const tail = combined === undefined ? '' : outputTail(stripTestConsoleBlocks(combined), maxChars);
  return tail || describeCommandFailureTail(r, maxChars);
}

export interface CommandRunCounts {
  format: 'vitest' | 'jest' | 'pytest' | 'tsc' | 'eslint';
  line: string;
  failed?: number;
  passed?: number;
  skipped?: number;
  errors?: number;
  warnings?: number;
  problems?: number;
}

const COUNT_PART = /\b(\d+) (failed|passed|skipped|errors?)\b/g;

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

export function parseCommandCounts(output: string): CommandRunCounts | null {
  const lines = output.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (/^Tests\s/.test(line)) {
      const parts = countParts(line.slice(5));
      if (parts) return { format: 'vitest', line: parts.line, ...parts.counts };
    }
  }

  for (const line of lines) {
    if (line.startsWith('Tests:') && / total\b/.test(line)) {
      const parts = countParts(line.slice(6));
      if (parts) return { format: 'jest', line: parts.line, ...parts.counts };
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('=') && line.endsWith('=') && /\bin [\d.]+s\b/.test(line)) {
      const parts = countParts(line);
      if (parts) return { format: 'pytest', line: parts.line, ...parts.counts };
    }
  }

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
