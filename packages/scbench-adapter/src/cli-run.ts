// packages/scbench-adapter/src/cli-run.ts — scbench-factory-agent argv parsing + execution (#510, #511).
import { readFile, writeFile } from 'node:fs/promises';

import { collectBaselineTrials, generateBaselineReport, loadBaselineConfig } from './baseline.js';
import { AdapterError, type ScbenchCheckpoint } from './checkpoint.js';
import { runCheckpoint, type RunCheckpointOptions } from './run-checkpoint.js';

const RUN_CHECKPOINT_USAGE =
  'usage: scbench-factory-agent run-checkpoint --workspace <dir> --artifacts <dir> --task-file <path> --problem <id> --checkpoint <id> [--index <n>] [--factory-bin <path>]';
const BASELINE_REPORT_USAGE = 'usage: scbench-factory-agent baseline-report --config <path> --runs <dir> --out <path>';
const USAGE = `${RUN_CHECKPOINT_USAGE}\n${BASELINE_REPORT_USAGE}`;

const REQUIRED_FLAGS = ['--workspace', '--artifacts', '--task-file', '--problem', '--checkpoint'] as const;
const BASELINE_REPORT_REQUIRED_FLAGS = ['--config', '--runs', '--out'] as const;

export interface CliDeps {
  readTaskFile: (path: string) => Promise<string>;
  runCheckpoint: (checkpoint: ScbenchCheckpoint, opts: RunCheckpointOptions) => ReturnType<typeof runCheckpoint>;
  readBaselineConfig: (path: string) => Promise<string>;
  collectBaselineTrials: typeof collectBaselineTrials;
  writeReport: (path: string, content: string) => Promise<void>;
  log: (line: string) => void;
  logError: (line: string) => void;
}

export function defaultCliDeps(): CliDeps {
  return {
    readTaskFile: (path) => readFile(path, 'utf-8'),
    runCheckpoint,
    readBaselineConfig: (path) => readFile(path, 'utf-8'),
    collectBaselineTrials,
    writeReport: (path, content) => writeFile(path, content),
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  };
}

function parseFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    flags[flag] = value;
    i += 1;
  }
  return flags;
}

/** Reads the task text from --task-file, calls runCheckpoint, and prints the
 *  CheckpointResult as single-line JSON on stdout. Returns the process exit
 *  code — 0 on any resolved CheckpointResult (including a failed/parked
 *  Factory run), 2 on a usage error or AdapterError. */
async function runRunCheckpoint(rest: readonly string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(rest);
  const missing = REQUIRED_FLAGS.filter((flag) => flags[flag] === undefined);
  if (missing.length > 0) {
    deps.logError(`missing required flag(s): ${missing.join(', ')}\n${RUN_CHECKPOINT_USAGE}`);
    return 2;
  }

  let task: string;
  try {
    task = await deps.readTaskFile(flags['--task-file']);
  } catch (err) {
    deps.logError(`could not read --task-file ${flags['--task-file']}: ${(err as Error).message}`);
    return 2;
  }

  const checkpoint: ScbenchCheckpoint = {
    problemId: flags['--problem'],
    checkpointId: flags['--checkpoint'],
    index: flags['--index'] !== undefined ? Number(flags['--index']) : 0,
    task,
  };

  try {
    const result = await deps.runCheckpoint(checkpoint, {
      workspace: flags['--workspace'],
      artifactsRoot: flags['--artifacts'],
      factoryBin: flags['--factory-bin'],
    });
    deps.log(JSON.stringify(result));
    return 0;
  } catch (err) {
    if (err instanceof AdapterError) {
      deps.logError(err.message);
      return 2;
    }
    throw err;
  }
}

/** Reads --config, collects trial manifests from --runs, regenerates the
 *  baseline report, and writes it to --out. The report derives only from
 *  the config + committed manifests — never hand-transcribed values or
 *  wall-clock state — so re-running this is how a caller proves the
 *  committed report.md hasn't drifted. */
async function runBaselineReport(rest: readonly string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(rest);
  const missing = BASELINE_REPORT_REQUIRED_FLAGS.filter((flag) => flags[flag] === undefined);
  if (missing.length > 0) {
    deps.logError(`missing required flag(s): ${missing.join(', ')}\n${BASELINE_REPORT_USAGE}`);
    return 2;
  }

  let raw: string;
  try {
    raw = await deps.readBaselineConfig(flags['--config']);
  } catch (err) {
    deps.logError(`could not read --config ${flags['--config']}: ${(err as Error).message}`);
    return 2;
  }

  try {
    const config = loadBaselineConfig(raw);
    const trials = deps.collectBaselineTrials(flags['--runs']);
    const report = generateBaselineReport(config, trials);
    await deps.writeReport(flags['--out'], report);
    deps.log(`wrote baseline report to ${flags['--out']}`);
    return 0;
  } catch (err) {
    if (err instanceof AdapterError) {
      deps.logError(err.message);
      return 2;
    }
    throw err;
  }
}

/** Hand-rolled argv parsing + dispatch across the `run-checkpoint` and
 *  `baseline-report` subcommands. */
export async function main(argv: readonly string[], deps: CliDeps = defaultCliDeps()): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'run-checkpoint') return runRunCheckpoint(rest, deps);
  if (subcommand === 'baseline-report') return runBaselineReport(rest, deps);

  deps.logError(USAGE);
  return 2;
}
