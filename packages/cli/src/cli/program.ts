// packages/cli/src/cli/program.ts — builds the factory commander program; registrations grouped by help group (#2793)

import { Command } from 'commander';
import { applyHelpGroups } from './help-groups.js';
import type { CliDeps, ProgramHandlers } from './index.js';
import { registerAdvancedCommands } from './program-advanced.js';
import { registerObserveCommands } from './program-observe.js';
import { registerQueueCommands } from './program-queue.js';
import { registerRunWorkCommands } from './program-run-work.js';
import { registerSetupCommands } from './program-setup.js';
import { applyConfigOverrideOptions } from './config-override-option.js';
import { applyStateRootOption } from './state-root.js';

export function buildProgram(handlers: ProgramHandlers, deps: CliDeps): Command {
  const program = new Command();

  program
    .name('factory')
    .description('Multi-agent software factory with boss-worker-checker orchestration')
    .version(handlers.getCliVersion())
    .addHelpText('before', handlers.PREREQUISITES_TEXT)
    .addHelpText('after', handlers.HELP_FOOTER_TEXT)
    .option(
      '--state-root <path>',
      'Keep factory state and config outside the checkout: an absolute path, ~/..., or "auto" (~/.factory/<owner>/<name>); env FACTORY_STATE_ROOT',
    )
    .option(
      '--config <path>',
      'Use this config file for the run instead of .factory/config.yaml; env FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML, merged with FACTORY_CONFIG_OVERRIDES',
    )
    .option(
      '--constitution <path>',
      'Use this constitution file for the run instead of the repo constitution; env FACTORY_CONSTITUTION_PATH / FACTORY_CONSTITUTION',
    );

  program.hook('preAction', async () => {
    try {
      const { config, constitution } = program.opts<{ config?: string; constitution?: string }>();
      applyConfigOverrideOptions({ config, constitution }, process.cwd());
    } catch (e) {
      throw new handlers.CliExitError(`factory: ${(e as Error).message}`, 2);
    }
    const flag = program.opts<{ stateRoot?: string }>().stateRoot;
    if (flag === undefined && !process.env.FACTORY_STATE_ROOT?.trim()) return;
    try {
      applyStateRootOption(flag, await handlers.getRepoRoot());
    } catch (e) {
      throw new handlers.CliExitError(`factory: ${(e as Error).message}`, 2);
    }
  });

  registerSetupCommands(program, handlers);
  registerObserveCommands(program, handlers, deps);
  registerQueueCommands(program, handlers);
  registerRunWorkCommands(program, handlers);
  registerAdvancedCommands(program, handlers, deps);

  applyHelpGroups(program);
  return program;
}
