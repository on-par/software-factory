import { runCommand, type RunCommandOptions } from '../utils/command-runner.js';

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

/** The accepted snapshot and merge flags belong to orchestration, not the repository being checked.
 * An explicit undefined survives the command runner's parent-env merge as a deletion. */
export function runVerificationCommand(argv: readonly string[], options: RunCommandOptions) {
  return runCommand(argv, {
    ...options,
    env: {
      ...options.env,
      ...Object.fromEntries(VERIFICATION_SCRUBBED_ENV_VARS.map((name) => [name, undefined])),
    },
  });
}
