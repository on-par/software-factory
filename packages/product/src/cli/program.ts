// packages/product/src/cli/program.ts — `product <command>` wiring (#469).

import { createRequire } from 'node:module';

import { Command } from 'commander';

import { listAdrFilenames, nextAdrFilename, resolveAdrHome } from '../adr-home.js';

export interface ProgramDeps {
  /** Repo root the ADR home is resolved against. */
  repoRoot: string;
  listAdrs: (dir: string) => string[];
  write: (line: string) => void;
}

export function getProductVersion(): string {
  return createRequire(import.meta.url)('../../package.json').version;
}

export function defaultDeps(): ProgramDeps {
  return {
    repoRoot: process.cwd(),
    listAdrs: (dir) => listAdrFilenames(dir),
    write: (line) => console.log(line),
  };
}

export function buildProgram(deps: ProgramDeps = defaultDeps()): Command {
  const program = new Command();

  program
    .name('product')
    .description('Product app — turn a brain-dump into engineering-ready issues (proposer: read-only)')
    .version(getProductVersion());

  const adr = program.command('adr').description('Architecture Decision Record helpers');

  adr
    .command('home')
    .description("Print the monorepo's ADR home directory")
    .action(() => {
      deps.write(resolveAdrHome(deps.repoRoot));
    });

  adr
    .command('next')
    .argument('<title>', 'title of the decision')
    .description('Print the filename for the next ADR, numbered by @on-par/adr-kit')
    .action((title: string) => {
      deps.write(nextAdrFilename(deps.listAdrs(resolveAdrHome(deps.repoRoot)), title));
    });

  return program;
}

export async function main(argv: string[] = process.argv, deps: ProgramDeps = defaultDeps()): Promise<void> {
  await buildProgram(deps).parseAsync(argv);
}
