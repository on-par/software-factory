import { readFileSync, writeFileSync } from 'node:fs';

import type { Baseline, EvalSummary } from '@on-par/factory-core';
import { compareToBaseline, formatRegressionIssue } from '@on-par/factory-core';

interface Args {
  report: string;
  baseline: string;
  runUrl?: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { report: 'eval-report.json', baseline: 'evals/baseline.json', out: 'regression-issue.md' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--report') args.report = argv[++i] ?? args.report;
    else if (arg === '--baseline') args.baseline = argv[++i] ?? args.baseline;
    else if (arg === '--run-url') args.runUrl = argv[++i];
    else if (arg === '--out') args.out = argv[++i] ?? args.out;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!args.runUrl) throw new Error('--run-url is required');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const summary: EvalSummary = JSON.parse(readFileSync(args.report, 'utf8'));
const baseline: Baseline = JSON.parse(readFileSync(args.baseline, 'utf8'));
const comparison = compareToBaseline(summary, baseline);

if (comparison.ok) {
  console.log('no regressions — not filing an issue');
  process.exitCode = 0;
} else {
  const { body } = formatRegressionIssue(summary, baseline, comparison, args.runUrl);
  writeFileSync(args.out, body);
  console.log(`wrote regression issue body to ${args.out}`);
}
