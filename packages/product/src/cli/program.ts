// packages/product/src/cli/program.ts — `product <command>` wiring (#469, #470, #471, #472, #473).

import { execSync } from 'node:child_process';
import { readFile as readFileFs } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { Command } from 'commander';

import { listAdrFilenames, nextAdrFilename, resolveAdrHome } from '../adr-home.js';
import type { Decomposition } from '../decompose/index.js';
import { decomposeIntent, renderDecomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import { approveIntentDoc, buildIntentDoc, renderIntentDoc } from '../intent/index.js';
import type { InterviewResult } from '../interview/index.js';
import { DEFAULT_QUESTION_BUDGET, formatQuestion, renderInterviewSummary, runInterview } from '../interview/index.js';
import { renderPersonaPanel, runPersonaPanel } from '../persona/index.js';
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

async function resolveBrainDump(
  opts: { text?: string; file?: string },
  deps: ProgramDeps,
  command: string,
): Promise<string> {
  const brainDump = opts.text ?? (opts.file === undefined ? undefined : await deps.readFile(opts.file));
  if (brainDump === undefined || brainDump.trim() === '') {
    throw new Error(`product ${command}: pass --text "<brain-dump>" or --file <path>`);
  }
  return brainDump;
}

function parseBudget(raw: string, command: string): number {
  const questionBudget = Number.parseInt(raw, 10);
  if (!Number.isInteger(questionBudget) || questionBudget < 0) {
    throw new Error(`product ${command}: --budget must be a non-negative integer`);
  }
  return questionBudget;
}

/** Shared by `decompose` and `personas`: brain-dump -> approved doc -> decomposition, or throw. */
async function decomposeFromDump(
  opts: { text?: string; file?: string; budget: string; approve: string },
  deps: ProgramDeps,
  command: string,
): Promise<{ doc: IntentDoc; decomposition: Decomposition }> {
  const brainDump = await resolveBrainDump(opts, deps, command);
  const questionBudget = parseBudget(opts.budget, command);
  const prompter = deps.createPrompter();
  let result: InterviewResult;
  try {
    result = await runInterview(
      brainDump,
      { ask: (question) => prompter.ask(formatQuestion(question)) },
      { questionBudget },
    );
  } finally {
    prompter.close();
  }

  const doc = buildIntentDoc(result);
  const approval = approveIntentDoc(doc, opts.approve);
  if (!approval.ok) {
    for (const line of renderIntentDoc(doc)) {
      deps.write(line);
    }
    throw new Error(`product ${command}: cannot approve — ${approval.blockers.join('; ')}`);
  }

  const decomposeResult = decomposeIntent(approval.doc);
  if (!decomposeResult.ok) {
    throw new Error(`product ${command}: ${decomposeResult.blockers.join('; ')}`);
  }

  return { doc: approval.doc, decomposition: decomposeResult.decomposition };
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
      const brainDump = await resolveBrainDump(opts, deps, 'interview');
      const questionBudget = parseBudget(opts.budget, 'interview');
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

  program
    .command('intent')
    .description('Build the intent doc from a brain-dump: stable statement IDs, PM approval gate')
    .option('-t, --text <text>', 'the brain-dump as an inline string')
    .option('-f, --file <path>', 'read the brain-dump from a file')
    .option('-b, --budget <n>', 'max clarifying questions', String(DEFAULT_QUESTION_BUDGET))
    .option('-a, --approve <approver>', 'approve the doc as <approver> (human gate #1)')
    .action(async (opts: { text?: string; file?: string; budget: string; approve?: string }) => {
      const brainDump = await resolveBrainDump(opts, deps, 'intent');
      const questionBudget = parseBudget(opts.budget, 'intent');
      const prompter = deps.createPrompter();
      let result: InterviewResult;
      try {
        result = await runInterview(
          brainDump,
          { ask: (question) => prompter.ask(formatQuestion(question)) },
          { questionBudget },
        );
      } finally {
        prompter.close();
      }

      let doc = buildIntentDoc(result);
      if (opts.approve !== undefined) {
        const approval = approveIntentDoc(doc, opts.approve);
        if (approval.ok) {
          doc = approval.doc;
        } else {
          for (const line of renderIntentDoc(doc)) {
            deps.write(line);
          }
          throw new Error(`product intent: cannot approve — ${approval.blockers.join('; ')}`);
        }
      }

      for (const line of renderIntentDoc(doc)) {
        deps.write(line);
      }
    });

  program
    .command('decompose')
    .description('Decompose an approved intent doc into an Epic plus INVEST stories with Gherkin AC')
    .option('-t, --text <text>', 'the brain-dump as an inline string')
    .option('-f, --file <path>', 'read the brain-dump from a file')
    .option('-b, --budget <n>', 'max clarifying questions', String(DEFAULT_QUESTION_BUDGET))
    .requiredOption('-a, --approve <approver>', 'approve the intent doc as <approver> (human gate #1)')
    // Scoped to this command only: a missing --approve throws a catchable CommanderError
    // instead of calling process.exit, matching every other command's error handling
    // (main()'s caller decides whether to exit) without changing --help/--version
    // behavior for the rest of the CLI.
    .exitOverride()
    .action(async (opts: { text?: string; file?: string; budget: string; approve: string }) => {
      const { decomposition } = await decomposeFromDump(opts, deps, 'decompose');
      for (const line of renderDecomposition(decomposition)) {
        deps.write(line);
      }
    });

  program
    .command('personas')
    .description('Interrogate a decomposition as eng/customer/support/security/ops')
    .option('-t, --text <text>', 'the brain-dump as an inline string')
    .option('-f, --file <path>', 'read the brain-dump from a file')
    .option('-b, --budget <n>', 'max clarifying questions', String(DEFAULT_QUESTION_BUDGET))
    .requiredOption('-a, --approve <approver>', 'approve the intent doc as <approver> (human gate #1)')
    // Scoped to this command only: a missing --approve throws a catchable CommanderError
    // instead of calling process.exit, matching every other command's error handling
    // (main()'s caller decides whether to exit) without changing --help/--version
    // behavior for the rest of the CLI.
    .exitOverride()
    .action(async (opts: { text?: string; file?: string; budget: string; approve: string }) => {
      const { doc, decomposition } = await decomposeFromDump(opts, deps, 'personas');
      for (const line of renderPersonaPanel(runPersonaPanel(decomposition, doc))) {
        deps.write(line);
      }
    });

  return program;
}

export async function main(argv: string[] = process.argv, deps: ProgramDeps = defaultDeps()): Promise<void> {
  await buildProgram(deps).parseAsync(argv);
}
