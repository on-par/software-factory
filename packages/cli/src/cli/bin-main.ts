// packages/cli/src/cli/bin-main.ts — the bin's main: builds the commander program from light modules and loads the engine only when a command runs (#3251)

import { styleText } from 'node:util';
import { lazyProgramHandlers } from './lazy-handlers.js';
import { CliExitError, formatOverview } from './light.js';
import { buildProgram } from './program.js';
import { runStalenessGuard } from './staleness.js';

export async function binMain(argv: string[] = process.argv): Promise<void> {
  if (argv.slice(2).length === 0) {
    console.log(formatOverview());
    return;
  }

  const staleExit = runStalenessGuard({
    entryUrl: import.meta.url,
    env: process.env,
    argv,
    error: (m) => console.error(styleText('red', m)),
    warn: (m) => console.error(styleText('yellow', m)),
  });
  if (staleExit !== null) {
    process.exitCode = staleExit;
    return;
  }

  try {
    await buildProgram(lazyProgramHandlers(), {}).parseAsync(argv);
  } catch (err) {
    if (err instanceof CliExitError) {
      console.error(styleText('red', err.message));
      process.exitCode = err.code;
      return;
    }
    throw err;
  }
}
