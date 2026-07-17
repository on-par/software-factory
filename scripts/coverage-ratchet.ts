import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import type { CoverageMetrics } from '@on-par/factory-core';
import {
  checkScopedRatchetDrift,
  DEFAULT_RATCHET_SLACK,
  parseCoverageSummaryScopes,
  renderRatchetReport,
} from '@on-par/factory-core';

import vitestConfig from '../vitest.config.js';

interface Args {
  summary: string;
  slack: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { summary: 'coverage/coverage-summary.json', slack: DEFAULT_RATCHET_SLACK };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--summary') args.summary = argv[++i] ?? args.summary;
    else if (arg === '--slack') args.slack = Number(argv[++i]);
    else throw new Error(`unknown flag: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const thresholds = vitestConfig.test?.coverage?.thresholds;
if (
  !thresholds ||
  typeof thresholds.lines !== 'number' ||
  typeof thresholds.functions !== 'number' ||
  typeof thresholds.branches !== 'number' ||
  typeof thresholds.statements !== 'number'
) {
  console.error('vitest.config.ts is missing numeric coverage.thresholds for lines/functions/branches/statements');
  process.exit(1);
}
const committedThresholds: Record<string, CoverageMetrics> = { global: thresholdMetrics(thresholds) };
for (const [scope, value] of Object.entries(thresholds)) {
  if (isCoverageMetrics(value)) committedThresholds[scope] = value;
}

if (!existsSync(args.summary)) {
  console.error(`coverage summary not found at ${args.summary} — run \`npm run test\` first`);
  process.exit(1);
}

const measured = parseCoverageSummaryScopes(readFileSync(args.summary, 'utf8'), Object.keys(committedThresholds));
const result = checkScopedRatchetDrift(measured, committedThresholds, args.slack);
const report = renderRatchetReport(result, args.slack);

console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${report}\n`);
}

process.exit(result.ok ? 0 : 1);

function thresholdMetrics(value: unknown): CoverageMetrics {
  if (!isCoverageMetrics(value)) {
    throw new Error('threshold value is missing numeric lines/functions/branches/statements');
  }
  return value;
}

function isCoverageMetrics(value: unknown): value is CoverageMetrics {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as CoverageMetrics).lines === 'number' &&
    typeof (value as CoverageMetrics).functions === 'number' &&
    typeof (value as CoverageMetrics).branches === 'number' &&
    typeof (value as CoverageMetrics).statements === 'number'
  );
}
