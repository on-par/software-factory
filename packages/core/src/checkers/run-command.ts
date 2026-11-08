import { checkerParentEnv } from '../environment/checker-env.js';
import { openCommandCapture } from '../command-output/capture.js';
import { type CommandResult, runCommand, type RunCommandOptions } from '../utils/command-runner.js';

/** Orchestration-only variables: the run-config snapshot plus the supervisor's merge/ship flags.
 * They must never change a repo's verification result (#3428). */
export const VERIFICATION_SCRUBBED_ENV_VARS = [
  'FACTORY_RUN_CONFIG_JSON',
  'FACTORY_RUN_CONFIG_ORIGIN',
  'FACTORY_MERGE',
  'FACTORY_MERGE_ADMIN',
  'FACTORY_LOCAL_ONLY',
  'FACTORY_SKIP_CI',
] as const;

/** Checker commands start from the env allow-list (#1590), so host secrets never reach agent-written scripts.
 * The accepted snapshot and merge flags belong to orchestration, not the repository being checked.
 * An explicit undefined survives the command runner's parent-env merge as a deletion. */
export async function runVerificationCommand(
  argv: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const capture = openCommandCapture();
  try {
    return await runCommand(argv, {
      ...options,
      parentEnv: checkerParentEnv(options.parentEnv ?? process.env),
      env: {
        ...options.env,
        ...Object.fromEntries(VERIFICATION_SCRUBBED_ENV_VARS.map((name) => [name, undefined])),
      },
      onOutput:
        capture || options.onOutput
          ? (stream, chunk) => {
              options.onOutput?.(stream, chunk);
              capture?.onChunk(stream, chunk);
            }
          : undefined,
    });
  } finally {
    capture?.close();
  }
}
