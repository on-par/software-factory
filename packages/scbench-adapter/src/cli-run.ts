// packages/scbench-adapter/src/cli-run.ts — scbench-factory-agent argv parsing + execution (#510).
import { readFile } from 'node:fs/promises';

import { AdapterError, type ScbenchCheckpoint } from './checkpoint.js';
import { runCheckpoint, type RunCheckpointOptions } from './run-checkpoint.js';

const USAGE =
  'usage: scbench-factory-agent run-checkpoint --workspace <dir> --artifacts <dir> --task-file <path> --problem <id> --checkpoint <id> [--index <n>] [--factory-bin <path>]';

const REQUIRED_FLAGS = ['--workspace', '--artifacts', '--task-file', '--problem', '--checkpoint'] as const;

export interface CliDeps {
  readTaskFile: (path: string) => Promise<string>;
  runCheckpoint: (checkpoint: ScbenchCheckpoint, opts: RunCheckpointOptions) => ReturnType<typeof runCheckpoint>;
  log: (line: string) => void;
  logError: (line: string) => void;
}

export function defaultCliDeps(): CliDeps {
  return {
    readTaskFile: (path) => readFile(path, 'utf-8'),
    runCheckpoint,
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

/** Hand-rolled argv parsing for the `run-checkpoint` subcommand: reads the
 *  task text from --task-file, calls runCheckpoint, and prints the
 *  CheckpointResult as single-line JSON on stdout. Returns the process exit
 *  code — 0 on any resolved CheckpointResult (including a failed/parked
 *  Factory run), 2 on a usage error or AdapterError. */
export async function main(argv: readonly string[], deps: CliDeps = defaultCliDeps()): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'run-checkpoint') {
    deps.logError(USAGE);
    return 2;
  }

  const flags = parseFlags(rest);
  const missing = REQUIRED_FLAGS.filter((flag) => flags[flag] === undefined);
  if (missing.length > 0) {
    deps.logError(`missing required flag(s): ${missing.join(', ')}\n${USAGE}`);
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
