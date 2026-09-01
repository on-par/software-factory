// packages/scbench-adapter/src/cli-run.ts — scbench-factory-agent argv parsing + execution (#510, #511, #1139).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadBaselineConfig, type BaselineConfig, collectBaselineTrials, generateBaselineReport } from './baseline.js';
import { runCatalogPreflight, type CatalogPreflightOutcome, type CatalogPreflightSpec } from './catalog-preflight.js';
import { AdapterError, type ScbenchCheckpoint } from './checkpoint.js';
import { collectTrial } from './collect-trial.js';
import { parsePinFile, runPinPreflight, type PinnedInputSpec, type PinPreflightOutcome } from './pin-preflight.js';
import { runCheckpoint, type RunCheckpointOptions } from './run-checkpoint.js';
import { createExecaExec } from './workspace.js';

const RUN_CHECKPOINT_USAGE =
  'usage: scbench-factory-agent run-checkpoint --workspace <dir> --artifacts <dir> --task-file <path> --problem <id> --checkpoint <id> [--index <n>] [--factory-bin <path>]';
const BASELINE_REPORT_USAGE = 'usage: scbench-factory-agent baseline-report --config <path> --runs <dir> --out <path>';
const PIN_PREFLIGHT_USAGE = 'usage: scbench-factory-agent pin-preflight [--pin <path>]';
const CATALOG_PREFLIGHT_USAGE = 'usage: scbench-factory-agent catalog-preflight [--config <path>]';
const LAUNCH_USAGE = 'usage: scbench-factory-agent launch [--pin <path>] [--config <path>] [--dry-run]';
const COLLECT_TRIAL_USAGE =
  'usage: scbench-factory-agent collect-trial --output <dir> --scbench-run <dir> --problem <id> --checkpoint <id> --trial <n> [--runs <dir>]';
const USAGE = `${RUN_CHECKPOINT_USAGE}\n${BASELINE_REPORT_USAGE}\n${PIN_PREFLIGHT_USAGE}\n${CATALOG_PREFLIGHT_USAGE}\n${LAUNCH_USAGE}\n${COLLECT_TRIAL_USAGE}`;

const LAUNCHER_CONFIG_ARG = 'packages/scbench-adapter/scbench.run.yaml';
const LAUNCHER_SCRIPT = 'packages/scbench-adapter/python/run_scbench.py';

const REQUIRED_FLAGS = ['--workspace', '--artifacts', '--task-file', '--problem', '--checkpoint'] as const;
const BASELINE_REPORT_REQUIRED_FLAGS = ['--config', '--runs', '--out'] as const;
const COLLECT_TRIAL_REQUIRED_FLAGS = ['--output', '--scbench-run', '--problem', '--checkpoint', '--trial'] as const;

const DEFAULT_PIN_PATH = fileURLToPath(new URL('../scbench.pin.json', import.meta.url));
const DEFAULT_ADAPTER_CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const DEFAULT_BASELINE_CONFIG_PATH = fileURLToPath(
  new URL('../../../evals/scbench-baseline/baseline.config.json', import.meta.url),
);
const DEFAULT_RUNS_DIR = fileURLToPath(new URL('../../../evals/scbench-baseline/runs', import.meta.url));

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
  collectTrial: typeof collectTrial;
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
    collectTrial,
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

type EvaluateResult<T> = { usageError: string } | T;

/** Body shared by `pin-preflight` and `launch`: read the pin file (defaulting
 *  to the package's committed scbench.pin.json), parse it, and check
 *  SCBENCH_CHECKOUT / SCBENCH_PROBLEMS_PATH against the pinned commits. */
async function evaluatePinPreflight(
  flags: Record<string, string>,
  deps: CliDeps,
): Promise<EvaluateResult<{ outcome: PinPreflightOutcome }>> {
  const pinPath = flags['--pin'] ?? DEFAULT_PIN_PATH;

  let raw: string;
  try {
    raw = await deps.readPinFile(pinPath);
  } catch (err) {
    return { usageError: `could not read pin file ${pinPath}: ${(err as Error).message}` };
  }

  try {
    const pin = parsePinFile(raw);
    const specs: PinnedInputSpec[] = [
      { input: 'SCBENCH_CHECKOUT', path: deps.env.SCBENCH_CHECKOUT, expectedCommit: pin.commit },
      { input: 'SCBENCH_PROBLEMS_PATH', path: deps.env.SCBENCH_PROBLEMS_PATH, expectedCommit: pin.problems.commit },
    ];
    return { outcome: await deps.runPinPreflight(specs) };
  } catch (err) {
    if (err instanceof AdapterError) {
      return { usageError: err.message };
    }
    throw err;
  }
}

/** Body shared by `catalog-preflight` and `launch`: read the baseline config
 *  (defaulting to the committed evals/scbench-baseline/baseline.config.json),
 *  and verify the compiled adapter bin plus every selected problem id
 *  (smoke + suite, deduped) resolves in the catalog checkout at
 *  SCBENCH_PROBLEMS_PATH. */
async function evaluateCatalogPreflight(
  flags: Record<string, string>,
  deps: CliDeps,
): Promise<EvaluateResult<{ outcome: CatalogPreflightOutcome; config: BaselineConfig }>> {
  const configPath = flags['--config'] ?? DEFAULT_BASELINE_CONFIG_PATH;

  let raw: string;
  try {
    raw = await deps.readBaselineConfig(configPath);
  } catch (err) {
    return { usageError: `could not read --config ${configPath}: ${(err as Error).message}` };
  }

  try {
    const config = loadBaselineConfig(raw);
    const problemIds = [...new Set([config.problems.smoke, ...config.problems.suite])];
    const outcome = deps.runCatalogPreflight({
      adapterCli: DEFAULT_ADAPTER_CLI_PATH,
      catalogPath: deps.env.SCBENCH_PROBLEMS_PATH,
      problemIds,
    });
    return { outcome, config };
  } catch (err) {
    if (err instanceof AdapterError) {
      return { usageError: err.message };
    }
    throw err;
  }
}

function renderPinResults(outcome: PinPreflightOutcome, deps: CliDeps): void {
  for (const result of outcome.results) {
    if (result.ok) {
      deps.log(`pin-preflight: ${result.input} ok — ${result.detail}`);
    } else {
      deps.logError(`pin-preflight: ${result.input} FAIL — ${result.detail}`);
    }
  }
}

function renderCatalogResults(outcome: CatalogPreflightOutcome, deps: CliDeps): void {
  for (const result of outcome.results) {
    if (result.ok) {
      deps.log(`catalog-preflight: ${result.subject} ok — ${result.detail}`);
    } else {
      deps.logError(`catalog-preflight: ${result.subject} FAIL — ${result.detail}`);
    }
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
  const result = await evaluatePinPreflight(flags, deps);
  if ('usageError' in result) {
    deps.logError(result.usageError);
    return 2;
  }

  renderPinResults(result.outcome, deps);
  return result.outcome.ok ? 0 : 1;
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
  const result = await evaluateCatalogPreflight(flags, deps);
  if ('usageError' in result) {
    deps.logError(result.usageError);
    return 2;
  }

  renderCatalogResults(result.outcome, deps);
  if (result.outcome.ok) {
    deps.log(`catalog-preflight: confirmed problem ids — ${result.outcome.confirmedProblemIds.join(', ')}`);
  }
  return result.outcome.ok ? 0 : 1;
}

function renderLauncherCommand(checkout: string, problemId: string): string {
  return `uv run --project "${checkout}" python ${LAUNCHER_SCRIPT} run --config ${LAUNCHER_CONFIG_ARG} --problem ${problemId}`;
}

/** Runs both existing preflights (pin + catalog) and, only when both pass,
 *  prints the exact pinned launcher command(s) and confirmed problem ids —
 *  it never invokes SCBench, uv, or any model. Both preflights run before any
 *  gating (no short-circuit), so a single failing run still reports every
 *  failing check. `--dry-run` is accepted and ignored — the command is
 *  inherently a dry run. Returns 2 on a pin-file/config read or parse error,
 *  1 when either preflight fails (no launcher line is printed), 0 on success. */
async function runLaunchCommand(rest: readonly string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(rest);
  const pin = await evaluatePinPreflight(flags, deps);
  if ('usageError' in pin) {
    deps.logError(pin.usageError);
    return 2;
  }
  const catalog = await evaluateCatalogPreflight(flags, deps);
  if ('usageError' in catalog) {
    deps.logError(catalog.usageError);
    return 2;
  }

  renderPinResults(pin.outcome, deps);
  renderCatalogResults(catalog.outcome, deps);

  if (!pin.outcome.ok || !catalog.outcome.ok) {
    return 1;
  }

  const checkout = deps.env.SCBENCH_CHECKOUT!;
  deps.log(`scbench: confirmed problem ids — ${catalog.outcome.confirmedProblemIds.join(', ')}`);
  deps.log('scbench: smoke launcher command (preflight passed; NOT invoked):');
  deps.log(renderLauncherCommand(checkout, catalog.config.problems.smoke));
  deps.log('scbench: suite launcher commands (preflight passed; NOT invoked):');
  for (const id of catalog.config.problems.suite) {
    deps.log(renderLauncherCommand(checkout, id));
  }
  return 0;
}

/** Copies the five Factory artifacts and the three native SCBench evidence
 *  files for one trial from the SCBench output tree's <problem>/<checkpoint>/
 *  directory and --scbench-run into <runs>/<problem>/<checkpoint>/trial-<n>/
 *  (default runs root: evals/scbench-baseline/runs), creating the trial
 *  directory when absent. Refuses to run without --scbench-run so native
 *  evidence collection can no longer be forgotten. Idempotent re-run: when
 *  the trial directory already holds every expected file, collectTrial
 *  performs zero writes and this logs an "already fully imported" line
 *  instead of the copied-files line. Returns 2 on a usage error or
 *  AdapterError (missing artifacts, bad manifest, missing native evidence),
 *  0 on success. */
async function runCollectTrialCommand(rest: readonly string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(rest);
  const missing = COLLECT_TRIAL_REQUIRED_FLAGS.filter((flag) => flags[flag] === undefined);
  if (missing.length > 0) {
    deps.logError(`missing required flag(s): ${missing.join(', ')}\n${COLLECT_TRIAL_USAGE}`);
    return 2;
  }

  const trial = Number(flags['--trial']);
  if (!Number.isInteger(trial) || trial < 1) {
    deps.logError(`--trial must be a positive integer, got ${flags['--trial']}\n${COLLECT_TRIAL_USAGE}`);
    return 2;
  }

  try {
    const result = deps.collectTrial({
      outputTree: flags['--output'],
      scbenchRunDir: flags['--scbench-run'],
      problemId: flags['--problem'],
      checkpointId: flags['--checkpoint'],
      trial,
      runsDir: flags['--runs'] ?? DEFAULT_RUNS_DIR,
    });
    if (result.alreadyImported) {
      deps.log(`collect-trial: trial already fully imported at ${result.trialDir} — nothing to copy`);
    } else {
      deps.log(`collect-trial: copied ${result.copied.join(', ')} → ${result.trialDir}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof AdapterError) {
      deps.logError(err.message);
      return 2;
    }
    throw err;
  }
}

/** Hand-rolled argv parsing + dispatch across the `run-checkpoint`,
 *  `baseline-report`, `pin-preflight`, `catalog-preflight`, `launch`, and
 *  `collect-trial` subcommands. */
export async function main(argv: readonly string[], deps: CliDeps = defaultCliDeps()): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'run-checkpoint') return runRunCheckpoint(rest, deps);
  if (subcommand === 'baseline-report') return runBaselineReport(rest, deps);
  if (subcommand === 'pin-preflight') return runPinPreflightCommand(rest, deps);
  if (subcommand === 'catalog-preflight') return runCatalogPreflightCommand(rest, deps);
  if (subcommand === 'launch') return runLaunchCommand(rest, deps);
  if (subcommand === 'collect-trial') return runCollectTrialCommand(rest, deps);

  deps.logError(USAGE);
  return 2;
}
