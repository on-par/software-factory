// packages/scbench-adapter/src/cli-run.ts — scbench-factory-agent argv parsing + execution (#510, #511, #1139).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { collectBaselineTrials, generateBaselineReport, loadBaselineConfig } from './baseline.js';
import { runCatalogPreflight, type CatalogPreflightOutcome, type CatalogPreflightSpec } from './catalog-preflight.js';
import { AdapterError, type ScbenchCheckpoint } from './checkpoint.js';
import { parsePinFile, runPinPreflight, type PinnedInputSpec, type PinPreflightOutcome } from './pin-preflight.js';
import { runCheckpoint, type RunCheckpointOptions } from './run-checkpoint.js';
import { createExecaExec } from './workspace.js';

const RUN_CHECKPOINT_USAGE =
  'usage: scbench-factory-agent run-checkpoint --workspace <dir> --artifacts <dir> --task-file <path> --problem <id> --checkpoint <id> [--index <n>] [--factory-bin <path>]';
const BASELINE_REPORT_USAGE = 'usage: scbench-factory-agent baseline-report --config <path> --runs <dir> --out <path>';
const PIN_PREFLIGHT_USAGE = 'usage: scbench-factory-agent pin-preflight [--pin <path>]';
const CATALOG_PREFLIGHT_USAGE = 'usage: scbench-factory-agent catalog-preflight [--config <path>]';
const USAGE = `${RUN_CHECKPOINT_USAGE}\n${BASELINE_REPORT_USAGE}\n${PIN_PREFLIGHT_USAGE}\n${CATALOG_PREFLIGHT_USAGE}`;

const REQUIRED_FLAGS = ['--workspace', '--artifacts', '--task-file', '--problem', '--checkpoint'] as const;
const BASELINE_REPORT_REQUIRED_FLAGS = ['--config', '--runs', '--out'] as const;

const DEFAULT_PIN_PATH = fileURLToPath(new URL('../scbench.pin.json', import.meta.url));
const DEFAULT_ADAPTER_CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const DEFAULT_BASELINE_CONFIG_PATH = fileURLToPath(
  new URL('../../../evals/scbench-baseline/baseline.config.json', import.meta.url),
);

export interface CliDeps {
  readTaskFile: (path: string) => Promise<string>;
  runCheckpoint: (checkpoint: ScbenchCheckpoint, opts: RunCheckpointOptions) => ReturnType<typeof runCheckpoint>;
  readBaselineConfig: (path: string) => Promise<string>;
  collectBaselineTrials: typeof collectBaselineTrials;
  writeReport: (path: string, content: string) => Promise<void>;
  log: (line: string) => void;
  logError: (line: string) => void;
  readPinFile: (path: string) => Promise<string>;
  env: Record<string, string | undefined>;
  runPinPreflight: (specs: readonly PinnedInputSpec[]) => Promise<PinPreflightOutcome>;
  runCatalogPreflight: (spec: CatalogPreflightSpec) => CatalogPreflightOutcome;
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
    readPinFile: (path) => readFile(path, 'utf-8'),
    env: process.env,
    runPinPreflight: (specs) => runPinPreflight(specs, { exec: createExecaExec() }),
    runCatalogPreflight: (spec) => runCatalogPreflight(spec, {}),
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

/** Reads the pin file (defaulting to the package's committed
 *  scbench.pin.json), validates SCBENCH_CHECKOUT and SCBENCH_PROBLEMS_PATH
 *  against the pinned commits, and prints one pass/fail line per input.
 *  Returns 2 on a pin-file read/parse error (a usage-class error, like the
 *  other subcommands), 1 when the preflight itself finds a failing input,
 *  0 when every input passes. */
async function runPinPreflightCommand(rest: readonly string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(rest);
  const pinPath = flags['--pin'] ?? DEFAULT_PIN_PATH;

  let raw: string;
  try {
    raw = await deps.readPinFile(pinPath);
  } catch (err) {
    deps.logError(`could not read pin file ${pinPath}: ${(err as Error).message}`);
    return 2;
  }

  let outcome: PinPreflightOutcome;
  try {
    const pin = parsePinFile(raw);
    const specs: PinnedInputSpec[] = [
      { input: 'SCBENCH_CHECKOUT', path: deps.env.SCBENCH_CHECKOUT, expectedCommit: pin.commit },
      { input: 'SCBENCH_PROBLEMS_PATH', path: deps.env.SCBENCH_PROBLEMS_PATH, expectedCommit: pin.problems.commit },
    ];
    outcome = await deps.runPinPreflight(specs);
  } catch (err) {
    if (err instanceof AdapterError) {
      deps.logError(err.message);
      return 2;
    }
    throw err;
  }

  for (const result of outcome.results) {
    if (result.ok) {
      deps.log(`pin-preflight: ${result.input} ok — ${result.detail}`);
    } else {
      deps.logError(`pin-preflight: ${result.input} FAIL — ${result.detail}`);
    }
  }
  return outcome.ok ? 0 : 1;
}

/** Reads the baseline config (defaulting to the committed
 *  evals/scbench-baseline/baseline.config.json), verifies the compiled
 *  adapter bin exists and every selected problem id (smoke + suite, deduped)
 *  resolves in the catalog checkout at SCBENCH_PROBLEMS_PATH, and prints one
 *  pass/fail line per subject. Returns 2 on a config read/parse error (a
 *  usage-class error, like the other subcommands), 1 when the preflight
 *  itself finds a failing subject, 0 when every subject passes. */
async function runCatalogPreflightCommand(rest: readonly string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(rest);
  const configPath = flags['--config'] ?? DEFAULT_BASELINE_CONFIG_PATH;

  let raw: string;
  try {
    raw = await deps.readBaselineConfig(configPath);
  } catch (err) {
    deps.logError(`could not read --config ${configPath}: ${(err as Error).message}`);
    return 2;
  }

  let outcome: CatalogPreflightOutcome;
  try {
    const config = loadBaselineConfig(raw);
    const problemIds = [...new Set([config.problems.smoke, ...config.problems.suite])];
    outcome = deps.runCatalogPreflight({
      adapterCli: DEFAULT_ADAPTER_CLI_PATH,
      catalogPath: deps.env.SCBENCH_PROBLEMS_PATH,
      problemIds,
    });
  } catch (err) {
    if (err instanceof AdapterError) {
      deps.logError(err.message);
      return 2;
    }
    throw err;
  }

  for (const result of outcome.results) {
    if (result.ok) {
      deps.log(`catalog-preflight: ${result.subject} ok — ${result.detail}`);
    } else {
      deps.logError(`catalog-preflight: ${result.subject} FAIL — ${result.detail}`);
    }
  }
  if (outcome.ok) {
    deps.log(`catalog-preflight: confirmed problem ids — ${outcome.confirmedProblemIds.join(', ')}`);
  }
  return outcome.ok ? 0 : 1;
}

/** Hand-rolled argv parsing + dispatch across the `run-checkpoint`,
 *  `baseline-report`, `pin-preflight`, and `catalog-preflight` subcommands. */
export async function main(argv: readonly string[], deps: CliDeps = defaultCliDeps()): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'run-checkpoint') return runRunCheckpoint(rest, deps);
  if (subcommand === 'baseline-report') return runBaselineReport(rest, deps);
  if (subcommand === 'pin-preflight') return runPinPreflightCommand(rest, deps);
  if (subcommand === 'catalog-preflight') return runCatalogPreflightCommand(rest, deps);

  deps.logError(USAGE);
  return 2;
}
