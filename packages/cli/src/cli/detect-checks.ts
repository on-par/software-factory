// packages/cli/src/cli/detect-checks.ts — `factory init --detect-checks`: find the build/test/lint commands CHECK
// should run, dry-run each one, and on confirmation write them under `checks` in the repo config.

import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { getFactoryPaths, isCommandAvailable } from '@on-par/factory-core';
import {
  buildDetectChecksPrompt,
  CHECK_KINDS,
  detectCheckHeuristics,
  heuristicProposal,
  parseDetectedChecks,
  readRepoConfigFile,
  runCommand,
  setRepoConfigValue,
  tokenizeEvidenceCommand,
  type CheckProposal,
} from '@on-par/factory-core/internal';

export interface DryRunResult {
  ok: boolean;
  /** One line: how long it took, or why it failed. */
  summary: string;
}

export interface DetectChecksDeps {
  repoRoot: string;
  /** The repo config file the commands are written to. */
  configPath: string;
  /** --yes: write the commands whose dry-run passed without asking. */
  yes: boolean;
  /** One detection-agent call returning its raw reply; undefined when no model can run. */
  runAgent?: (prompt: string) => Promise<string>;
  dryRun: (argv: string[]) => Promise<DryRunResult>;
  /** Asks a yes/no question; false when nobody can answer it. */
  confirm: (question: string) => Promise<boolean>;
  log: (line: string) => void;
  writeChecks?: (configPath: string, checks: CheckProposal) => void;
}

export interface DetectChecksOutcome {
  proposal: CheckProposal;
  /** 'agent' when the agent's proposal was used, else 'heuristics'. */
  source: 'heuristics' | 'agent';
  dryRuns: Partial<Record<keyof CheckProposal, DryRunResult>>;
  /** The `checks` section written, or null when nothing was written. */
  written: CheckProposal | null;
}

function existingChecks(configPath: string): CheckProposal {
  const checks = (readRepoConfigFile(configPath) as { checks?: unknown } | undefined)?.checks;
  return typeof checks === 'object' && checks !== null && !Array.isArray(checks) ? (checks as CheckProposal) : {};
}

async function propose(deps: DetectChecksDeps): Promise<{ proposal: CheckProposal; source: 'heuristics' | 'agent' }> {
  const { repoRoot, log } = deps;
  const heuristics = await detectCheckHeuristics(repoRoot);
  const fallback = heuristicProposal(heuristics);
  if (heuristics.ambiguities.length === 0) return { proposal: fallback, source: 'heuristics' };

  log(`Heuristics are ambiguous: ${heuristics.ambiguities.join('; ')}`);
  if (!deps.runAgent) {
    log('No model available to read the docs; using the heuristic guess.');
    return { proposal: fallback, source: 'heuristics' };
  }
  log('Asking an agent to read the README, AGENTS.md, CONTRIBUTING, CI workflows and scripts...');
  try {
    const parsed = parseDetectedChecks(await deps.runAgent(await buildDetectChecksPrompt(repoRoot, heuristics)));
    if (parsed) {
      for (const rejected of parsed.rejected)
        log(`Dropped an agent proposal that is not one shell-free command: ${rejected}`);
      if (parsed.notes) log(`Agent: ${parsed.notes}`);
      if (Object.keys(parsed.proposal).length > 0) return { proposal: parsed.proposal, source: 'agent' };
    }
    log('The agent proposed no commands; using the heuristic guess.');
  } catch (err) {
    log(`The detection agent failed (${err instanceof Error ? err.message : String(err)}); using the heuristic guess.`);
  }
  return { proposal: fallback, source: 'heuristics' };
}

/** Detect, dry-run, confirm and write the repo's CHECK commands. Never throws for a failed agent or dry-run. */
export async function runDetectChecks(deps: DetectChecksDeps): Promise<DetectChecksOutcome> {
  const { configPath, log } = deps;
  const { proposal, source } = await propose(deps);
  const dryRuns: DetectChecksOutcome['dryRuns'] = {};
  if (Object.keys(proposal).length === 0) {
    log('No build, test or lint command found. Declare them by hand under `checks` in the repo config.');
    return { proposal, source, dryRuns, written: null };
  }

  const keep: CheckProposal = {};
  for (const kind of CHECK_KINDS) {
    const command = proposal[kind];
    if (command === undefined) continue;
    log(`Dry-running ${kind}: ${command}`);
    const result = await deps.dryRun([...tokenizeEvidenceCommand(command)!]);
    dryRuns[kind] = result;
    log(`  ${result.ok ? 'ok' : 'FAILED'}: ${result.summary}`);
    if (result.ok || (!deps.yes && (await deps.confirm(`Keep ${kind} \`${command}\` although its dry-run failed?`)))) {
      keep[kind] = command;
    }
  }
  if (Object.keys(keep).length === 0) {
    log('No command passed its dry-run; nothing written.');
    return { proposal, source, dryRuns, written: null };
  }

  const file = `.factory/${basename(configPath)}`;
  const listing = CHECK_KINDS.filter((k) => keep[k] !== undefined)
    .map((k) => `${k}: ${keep[k]}`)
    .join(', ');
  if (!deps.yes && !(await deps.confirm(`Write checks (${listing}) to ${file}?`))) {
    log(`Not written. Rerun with --yes, or add them under \`checks\` in ${file} by hand.`);
    return { proposal, source, dryRuns, written: null };
  }
  const written = { ...existingChecks(configPath), ...keep };
  (deps.writeChecks ?? ((path, checks) => setRepoConfigValue(path, ['checks'], checks)))(configPath, written);
  log(`Wrote checks to ${file} (${listing}). \`factory doctor\` shows what CHECK will run.`);
  return { proposal, source, dryRuns, written };
}

const DRY_RUN_TIMEOUT_MS = 15 * 60_000;

/** Minimal router surface the detection agent needs (a ModelRouter satisfies it). */
export interface DetectChecksRouter {
  run(task: string, prompt: string, opts: { worktree: string; timeoutSeconds: number }): Promise<{ output: string }>;
}

/** `factory init --detect-checks`: detect with the repo's router (missing harness CLIs skipped) into its config file. */
export async function detectChecksForInit(
  repoRoot: string,
  router: DetectChecksRouter & { skipMissingHarnessClis(available: (cmd: string) => boolean): void },
  yes: boolean,
  tty?: Parameters<typeof detectChecksIo>[2],
): Promise<DetectChecksOutcome> {
  router.skipMissingHarnessClis(isCommandAvailable);
  const io = detectChecksIo(repoRoot, router, tty);
  return runDetectChecks({ ...io, configPath: getFactoryPaths(repoRoot).config, yes });
}

/** The real agent, dry-run, confirm and log for `factory init --detect-checks`. Confirm answers no off a TTY. */
export function detectChecksIo(
  repoRoot: string,
  router?: DetectChecksRouter,
  tty: { input: NodeJS.ReadableStream & { isTTY?: boolean }; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): Pick<DetectChecksDeps, 'repoRoot' | 'runAgent' | 'dryRun' | 'confirm' | 'log'> {
  return {
    repoRoot,
    ...(router && {
      runAgent: async (prompt: string) =>
        (await router.run('detect_checks', prompt, { worktree: repoRoot, timeoutSeconds: 600 })).output,
    }),
    dryRun: async (argv) => {
      const started = Date.now();
      const r = await runCommand(argv, { cwd: repoRoot, timeoutMs: DRY_RUN_TIMEOUT_MS });
      const seconds = Math.round((Date.now() - started) / 1000);
      if (r.ok) return { ok: true, summary: `exit 0 in ${seconds}s` };
      const tail = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(-3).join(' | ').slice(0, 300);
      const why = r.timedOut ? `timed out after ${seconds}s` : `exit ${r.exitCode}`;
      return { ok: false, summary: tail ? `${why}: ${tail}` : why };
    },
    confirm: async (question) => {
      if (!tty.input.isTTY) return false;
      const rl = createInterface({ input: tty.input, output: tty.output });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    log: (line) => console.log(line),
  };
}
