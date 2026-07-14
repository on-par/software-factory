import { readFileSync, writeFileSync } from 'node:fs';
import { buildLocalSmallScoreboard, renderLocalSmallScoreboardMarkdown } from '@on-par/factory-core';
import type { LocalSmallScoreboardInput, LocalSmallScoreboardRun } from '@on-par/factory-core';

interface Args {
  input?: string;
  baseline?: string;
  output?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') args.input = argv[++i];
    else if (arg === '--baseline') args.baseline = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!args.input) throw new Error('usage: npm run local-small-scoreboard -- --input runs.json [--baseline baseline.json] [--output report.md]');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const runs = readRuns(args.input!);
const baseline = args.baseline ? { runs: readRuns(args.baseline) } : undefined;
const input: LocalSmallScoreboardInput = { runs, ...(baseline ? { baseline } : {}) };
const markdown = renderLocalSmallScoreboardMarkdown(buildLocalSmallScoreboard(input));

if (args.output) {
  writeFileSync(args.output, markdown);
} else {
  console.log(markdown);
}

function readRuns(path: string): LocalSmallScoreboardRun[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (Array.isArray(parsed)) return parsed.map(validateRun);
  if (isRecord(parsed) && Array.isArray(parsed.runs)) return parsed.runs.map(validateRun);
  throw new Error(`${path}: expected an array or an object with a runs array`);
}

function validateRun(value: unknown): LocalSmallScoreboardRun {
  if (!isRecord(value)) throw new Error('scoreboard run must be an object');
  const run = {
    scenario: stringField(value, 'scenario'),
    runtime: stringField(value, 'runtime'),
    model: stringField(value, 'model'),
    patchApplied: booleanField(value, 'patchApplied'),
    testsPassed: booleanField(value, 'testsPassed'),
    diffSize: numberField(value, 'diffSize'),
    repairCount: numberField(value, 'repairCount'),
    durationMs: numberField(value, 'durationMs'),
    reviewerGrade: numberField(value, 'reviewerGrade'),
  };
  return run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`scoreboard run requires string ${field}`);
  return value;
}

function booleanField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') throw new Error(`scoreboard run requires boolean ${field}`);
  return value;
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`scoreboard run requires finite number ${field}`);
  return value;
}
