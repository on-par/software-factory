import { runCommand, type RunCommandOptions } from '../utils/command-runner.js';

/** The accepted snapshot belongs to orchestration, not the repository being checked.
 * An explicit undefined survives the command runner's parent-env merge as a deletion. */
export function runVerificationCommand(argv: readonly string[], options: RunCommandOptions) {
  return runCommand(argv, {
    ...options,
    env: { ...options.env, FACTORY_RUN_CONFIG_JSON: undefined },
  });
}
