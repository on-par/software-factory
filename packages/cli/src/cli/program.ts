// packages/cli/src/cli/program.ts — builds the factory commander program; registrations grouped by help group (#2793)

import { Command } from 'commander';
import { applyHelpGroups } from './help-groups.js';
import type { CliDeps, ProgramHandlers } from './index.js';
import { registerAdvancedCommands } from './program-advanced.js';
import { registerObserveCommands } from './program-observe.js';
import { registerQueueCommands } from './program-queue.js';
import { registerRunWorkCommands } from './program-run-work.js';
import { registerSetupCommands } from './program-setup.js';
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
    );

  program.hook('preAction', async () => {
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
