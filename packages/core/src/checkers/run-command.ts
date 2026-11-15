import { checkerParentEnv } from '../environment/checker-env.js';
import { openCommandCapture } from '../command-output/capture.js';
import { type CommandResult, runCommand, type RunCommandOptions } from '../utils/command-runner.js';

export const VERIFICATION_SCRUBBED_ENV_VARS = [
  'FACTORY_RUN_CONFIG_JSON',
  'FACTORY_RUN_CONFIG_ORIGIN',
  'FACTORY_MERGE',
  'FACTORY_MERGE_ADMIN',
  'FACTORY_LOCAL_ONLY',
  'FACTORY_SKIP_CI',
] as const;

export async function runVerificationCommand(
  argv: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const explicitUndefinedSurvivesParentEnvMergeAsDeletion = Object.fromEntries(
    VERIFICATION_SCRUBBED_ENV_VARS.map((name) => [name, undefined]),
  );
  const capture = openCommandCapture();
  try {
    return await runCommand(argv, {
      ...options,
      parentEnv: checkerParentEnv(options.parentEnv ?? process.env),
      env: {
        ...options.env,
        ...explicitUndefinedSurvivesParentEnvMergeAsDeletion,
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
