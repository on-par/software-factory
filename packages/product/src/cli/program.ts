// packages/product/src/cli/program.ts — `product <command>` wiring (#469, #470).

import { execSync } from 'node:child_process';
import { readFile as readFileFs } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { Command } from 'commander';

import { listAdrFilenames, nextAdrFilename, resolveAdrHome } from '../adr-home.js';
import { DEFAULT_QUESTION_BUDGET, formatQuestion, renderInterviewSummary, runInterview } from '../interview/index.js';
import type { Prompter } from './prompter.js';
import { createStdinPrompter } from './prompter.js';

export interface ProgramDeps {
  /** Repo root the ADR home is resolved against. */
  repoRoot: string;
  listAdrs: (dir: string) => string[];
  write: (line: string) => void;
  /** Reads the brain-dump file for `interview --file`. */
  readFile: (path: string) => Promise<string>;
  /** Opens the interactive Q&A channel for `interview`. */
  createPrompter: () => Prompter;
}

export function getProductVersion(): string {
  return createRequire(import.meta.url)('../../package.json').version;
}

/**
 * The monorepo root, not the process's cwd — matches `factory`'s own
 * `getRepoRoot()` (packages/cli/src/cli/index.ts). Without this, `product adr
 * home`/`adr next` compute the wrong ADR home (or ENOENT) whenever invoked
 * from a subdirectory, e.g. `npm run dev -w packages/product`.
 */
function resolveRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

export function defaultDeps(): ProgramDeps {
  return {
    repoRoot: resolveRepoRoot(),
    listAdrs: (dir) => listAdrFilenames(dir),
    write: (line) => console.log(line),
    readFile: (path) => readFileFs(path, 'utf-8'),
    createPrompter: () => createStdinPrompter(),
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

  program
    .command('interview')
    .description('Interview a brain-dump: ask clarifying questions until intent is pinned')
    .option('-t, --text <text>', 'the brain-dump as an inline string')
    .option('-f, --file <path>', 'read the brain-dump from a file')
    .option('-b, --budget <n>', 'max clarifying questions', String(DEFAULT_QUESTION_BUDGET))
    .action(async (opts: { text?: string; file?: string; budget: string }) => {
      const brainDump = opts.text ?? (opts.file === undefined ? undefined : await deps.readFile(opts.file));
      if (brainDump === undefined || brainDump.trim() === '') {
        throw new Error('product interview: pass --text "<brain-dump>" or --file <path>');
      }
      const questionBudget = Number.parseInt(opts.budget, 10);
      if (!Number.isInteger(questionBudget) || questionBudget < 0) {
        throw new Error('product interview: --budget must be a non-negative integer');
      }
      const prompter = deps.createPrompter();
      try {
        const result = await runInterview(
          brainDump,
          { ask: (question) => prompter.ask(formatQuestion(question)) },
          { questionBudget },
        );
        for (const line of renderInterviewSummary(result)) {
          deps.write(line);
        }
      } finally {
        prompter.close();
      }
    });

  return program;
}

export async function main(argv: string[] = process.argv, deps: ProgramDeps = defaultDeps()): Promise<void> {
  await buildProgram(deps).parseAsync(argv);
}
