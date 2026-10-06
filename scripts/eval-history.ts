import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { EvalSummary } from '@on-par/factory-core';
import { appendHistoryLine, parseHistory, renderTrend, summaryToHistoryRecord } from '@on-par/factory-core';

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

/** The file's contents, or undefined when it does not exist. Reading directly
 *  (instead of existsSync first) leaves no gap for the file to change. */
export function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function runEvalHistory(argv: string[], out: (text: string) => void = (t) => process.stdout.write(t)): void {
  const args = parseArgs(argv);

  const report = readFileIfExists(args.report);
  if (report === undefined) {
    out(`no report at ${args.report} — skipping trend append\n`);
    return;
  }
  const summary: EvalSummary = JSON.parse(report);
  const existing = readFileIfExists(args.history) ?? '';
  const record = summaryToHistoryRecord(summary, args.date, args.runUrl);
  const updated = appendHistoryLine(existing, record);

  writeFileSync(args.history, updated);
  out(renderTrend(parseHistory(updated)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runEvalHistory(process.argv.slice(2));
}
