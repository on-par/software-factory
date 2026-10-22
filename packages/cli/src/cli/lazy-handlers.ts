// packages/cli/src/cli/lazy-handlers.ts — ProgramHandlers whose command handlers load index.js on first use, so --help never loads the engine (#3251)

import type { ProgramHandlers } from './index.js';
import { CliExitError, getCliVersion, HELP_FOOTER_TEXT, parseIssueArg, PREREQUISITES_TEXT } from './light.js';

const LIGHT: Record<string, unknown> = {
  CliExitError,
  getCliVersion,
  HELP_FOOTER_TEXT,
  parseIssueArg,
  PREREQUISITES_TEXT,
};

type Loaded = { PROGRAM_HANDLERS: ProgramHandlers };

/** Light keys come from light.ts; every other key forwards to PROGRAM_HANDLERS after a memoised `import('./index.js')`. */
export function lazyProgramHandlers(load: () => Promise<Loaded> = () => import('./index.js')): ProgramHandlers {
  let loaded: Promise<Loaded> | undefined;
  const memoisedLoad = () => (loaded ??= load());
  const table: Record<string, unknown> = { ...LIGHT };
  return new Proxy(table, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key in target) return target[key];
      const forwarder = async (...args: unknown[]) => {
        const handler: unknown = (await memoisedLoad()).PROGRAM_HANDLERS[key as keyof ProgramHandlers];
        if (typeof handler !== 'function') throw new Error(`factory: unknown command handler '${key}'`);
        return handler(...args);
      };
      target[key] = forwarder;
      return forwarder;
    },
  }) as ProgramHandlers;
}
