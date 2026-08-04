// packages/core/src/sim/monte-carlo-cli.ts — argv parsing, config loading, output, and the
// exit-code contract for the Monte Carlo runner. Every effect (stdout, stderr, file I/O, the
// runner itself) is injected so the whole module is unit testable; it never calls
// process.exit — scripts/sim-monte-carlo.ts owns turning the return value into one.

import { readFile as readFileFs, writeFile as writeFileFs } from 'node:fs/promises';

import type { MonteCarloOptions, MonteCarloReport, MonteCarloThresholds } from './monte-carlo.js';
import { monteCarloExitCode, renderMonteCarloTable, runMonteCarlo } from './monte-carlo.js';
import type { SimJitterConfig } from './jitter.js';
import type { SimIssueSpec } from './pipeline.js';

export type MonteCarloFormat = 'json' | 'table' | 'both';

export interface MonteCarloCliArgs {
  runs: number;
  issues: number;
  seed: number;
  concurrency: number;
  format: MonteCarloFormat;
  failureRate?: number;
  jitterPath?: string;
  thresholds: MonteCarloThresholds;
  output?: string;
  help: boolean;
}

export interface MonteCarloCliDeps {
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, content: string) => Promise<void>;
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
  run?: (options: MonteCarloOptions) => Promise<MonteCarloReport>;
}

export const MONTE_CARLO_CLI_USAGE = `Usage: sim-monte-carlo [options]

Runs the headless simulator's Monte Carlo layer: M independent batches of
synthetic issues through fake PLAN -> BUILD -> CHECK -> SHIP, aggregated
into shipped/parked/escalated rates. No real model provider or GitHub call
is reachable.

Options:
  --runs <n>                 Number of simulations to run (default: 10)
  --issues <n>                Synthetic issues per run (default: 3)
  --seed <n>                  Base jitter seed (default: 1)
  --concurrency <n>           Max runs in flight (default: 1)
  --format <json|table|both>  Output format (default: table)
  --failure-rate <r>          Uniform per-call failure rate in [0, 1]; mutually exclusive with --jitter
  --jitter <path>             Path to a JSON SimJitterConfig; mutually exclusive with --failure-rate
  --max-failure-rate <r>      Breach threshold for (parked + escalated) / totalIssues
  --max-park-rate <r>         Breach threshold for parked / totalIssues
  --max-escalation-rate <r>   Breach threshold for escalated / totalIssues
  --output <path>             Also write the JSON report to this path
  -h, --help                  Show this help

Exit codes:
  0  clean report, no threshold breached
  1  a configured threshold was breached
  2  usage error or runner failure
`;

export function parseMonteCarloArgs(argv: string[]): MonteCarloCliArgs {
  const args: MonteCarloCliArgs = {
    runs: 10,
    issues: 3,
    seed: 1,
    concurrency: 1,
    format: 'table',
    thresholds: {},
    help: false,
  };

  const parseIntFlag = (arg: string, raw: string | undefined, allowZero: boolean): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value) || (allowZero ? value < 0 : value < 1)) {
      throw new Error(`invalid flag: ${arg}`);
    }
    return value;
  };

  const parseRateFlag = (arg: string, raw: string | undefined): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`invalid flag: ${arg}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--runs') args.runs = parseIntFlag(arg, argv[++i], false);
    else if (arg === '--issues') args.issues = parseIntFlag(arg, argv[++i], false);
    else if (arg === '--seed') args.seed = parseIntFlag(arg, argv[++i], true);
    else if (arg === '--concurrency') args.concurrency = parseIntFlag(arg, argv[++i], false);
    else if (arg === '--failure-rate') args.failureRate = parseRateFlag(arg, argv[++i]);
    else if (arg === '--max-failure-rate') args.thresholds.maxFailureRate = parseRateFlag(arg, argv[++i]);
    else if (arg === '--max-park-rate') args.thresholds.maxParkRate = parseRateFlag(arg, argv[++i]);
    else if (arg === '--max-escalation-rate') args.thresholds.maxEscalationRate = parseRateFlag(arg, argv[++i]);
    else if (arg === '--jitter') args.jitterPath = argv[++i];
    else if (arg === '--format') {
      const value = argv[++i];
      if (value !== 'json' && value !== 'table' && value !== 'both') throw new Error(`invalid flag: ${arg}`);
      args.format = value;
    } else if (arg === '--output') args.output = argv[++i];
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }

  if (args.jitterPath !== undefined && args.failureRate !== undefined) {
    throw new Error('--jitter and --failure-rate are mutually exclusive');
  }

  return args;
}

export function simMonteCarloIssues(count: number): SimIssueSpec[] {
  return Array.from({ length: count }, (_, i) => ({ issue: 9600 + i, title: `Sim Monte Carlo issue ${i + 1}` }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function runMonteCarloCli(argv: string[], deps: MonteCarloCliDeps = {}): Promise<number> {
  const readFile = deps.readFile ?? ((path: string) => readFileFs(path, 'utf8'));
  const writeFile = deps.writeFile ?? ((path: string, content: string) => writeFileFs(path, content));
  const write = deps.write ?? ((line: string) => console.log(line));
  const writeErr = deps.writeErr ?? ((line: string) => console.error(line));
  const run = deps.run ?? runMonteCarlo;

  let args: MonteCarloCliArgs;
  try {
    args = parseMonteCarloArgs(argv);
  } catch (err) {
    writeErr(`sim-monte-carlo: ${err instanceof Error ? err.message : String(err)}`);
    writeErr(MONTE_CARLO_CLI_USAGE);
    return 2;
  }

  if (args.help) {
    write(MONTE_CARLO_CLI_USAGE);
    return 0;
  }

  try {
    const jitter = await resolveJitterConfig(args, readFile);
    const report = await run({
      runs: args.runs,
      concurrency: args.concurrency,
      thresholds: args.thresholds,
      simulation: { issues: simMonteCarloIssues(args.issues), jitter },
    });

    if (args.format === 'table' || args.format === 'both') write(renderMonteCarloTable(report));
    if (args.format === 'json' || args.format === 'both') write(JSON.stringify(report, null, 2));

    if (args.output) await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');

    return monteCarloExitCode(report);
  } catch (err) {
    writeErr(`sim-monte-carlo: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

async function resolveJitterConfig(
  args: MonteCarloCliArgs,
  readFile: (path: string) => Promise<string>,
): Promise<SimJitterConfig> {
  if (args.jitterPath) {
    const raw = JSON.parse(await readFile(args.jitterPath)) as unknown;
    if (!isPlainObject(raw)) throw new Error(`--jitter ${args.jitterPath}: expected a JSON object`);
    const seed = typeof raw.seed === 'number' ? raw.seed : args.seed;
    return { ...raw, seed } as SimJitterConfig;
  }
  return { seed: args.seed, ...(args.failureRate !== undefined ? { default: { failureRate: args.failureRate } } : {}) };
}
