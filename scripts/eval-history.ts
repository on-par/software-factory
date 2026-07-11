import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  appendHistoryLine,
  parseHistory,
  renderTrend,
  summaryToHistoryRecord,
} from '@on-par/factory-core';
import type { EvalSummary } from '@on-par/factory-core';

interface Args {
  report: string;
  history: string;
  runUrl?: string;
  date: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    report: 'eval-report.json',
    history: 'history.jsonl',
    date: new Date().toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--report') args.report = argv[++i] ?? args.report;
    else if (arg === '--history') args.history = argv[++i] ?? args.history;
    else if (arg === '--run-url') args.runUrl = argv[++i];
    else if (arg === '--date') args.date = argv[++i] ?? args.date;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(args.report)) {
  console.log(`no report at ${args.report} — skipping trend append`);
  process.exitCode = 0;
} else {
  const summary: EvalSummary = JSON.parse(readFileSync(args.report, 'utf8'));
  const existing = existsSync(args.history) ? readFileSync(args.history, 'utf8') : '';
  const record = summaryToHistoryRecord(summary, args.date, args.runUrl);
  const updated = appendHistoryLine(existing, record);

  writeFileSync(args.history, updated);
  process.stdout.write(renderTrend(parseHistory(updated)));
}
