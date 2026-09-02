// packages/scbench-adapter/src/suite.ts — complete-suite runner: every
// configured suite problem through the pinned launcher, continuing after
// failed problems, with a completed/failed/missing summary (#1164).
import type { ExecFn } from './workspace.js';

export const LAUNCHER_SCRIPT = 'packages/scbench-adapter/python/run_scbench.py';
export const LAUNCHER_CONFIG_ARG = 'packages/scbench-adapter/scbench.run.yaml';

/** One attempted suite problem: the launcher ran and reported an exit code.
 *  A problem whose exec threw (spawn crash) gets no record at all — it is
 *  classified as missing, never as completed (ADR-0007: absent evidence is
 *  never a pass). */
export interface SuiteProblemRecord {
  problemId: string;
  exitCode: number;
}

export interface SuiteSummary {
  completed: string[];
  failed: string[];
  missing: string[];
}

export interface RunSuiteOptions {
  checkout: string;
  problemIds: readonly string[];
  cwd: string;
  /** Name of a harmless placeholder env var to satisfy upstream's provider
   *  credential presence check (its value is never validated or forwarded).
   *  Never name ANTHROPIC_API_KEY here — populating that var overrides the
   *  nested claude CLI's OAuth session (evals/scbench-baseline/README.md). */
  providerApiKeyEnv?: string;
}

export interface RunSuiteDeps {
  exec: ExecFn;
  log: (line: string) => void;
}

/** The exact pinned launcher command `launch` renders as a string, as argv.
 *  When providerApiKeyEnv is a non-empty string, `--provider-api-key-env
 *  <var>` is appended (upstream's credential gate reads the named var);
 *  otherwise the argv is byte-identical to the pinned command. */
export function buildSuiteLauncherArgv(checkout: string, problemId: string, providerApiKeyEnv?: string): string[] {
  const argv = [
    'uv',
    'run',
    '--project',
    checkout,
    'python',
    LAUNCHER_SCRIPT,
    'run',
    '--config',
    LAUNCHER_CONFIG_ARG,
    '--problem',
    problemId,
  ];
  if (providerApiKeyEnv !== undefined && providerApiKeyEnv !== '') {
    argv.push('--provider-api-key-env', providerApiKeyEnv);
  }
  return argv;
}

/** Runs every configured suite problem in order through the pinned launcher,
 *  with the leaked parent VIRTUAL_ENV stripped from the child env (#1164).
 *  A non-zero exit or a thrown exec never stops the loop — later problems
 *  always run; a thrown exec yields no record for that problem. */
export async function runSuite(opts: RunSuiteOptions, deps: RunSuiteDeps): Promise<SuiteProblemRecord[]> {
  const records: SuiteProblemRecord[] = [];
  for (const problemId of opts.problemIds) {
    deps.log(`suite: running ${problemId}`);
    try {
      const result = await deps.exec(buildSuiteLauncherArgv(opts.checkout, problemId, opts.providerApiKeyEnv), {
        cwd: opts.cwd,
        env: { VIRTUAL_ENV: undefined },
      });
      records.push({ problemId, exitCode: result.exitCode });
      deps.log(`suite: ${problemId} exited ${result.exitCode}${result.exitCode === 0 ? '' : ' — continuing'}`);
    } catch (err) {
      deps.log(`suite: ${problemId} crashed: ${(err as Error).message} — continuing`);
    }
  }
  return records;
}

/** Classifies every configured problem as exactly one of completed (a record
 *  with exit 0), failed (a record with non-zero exit), or missing (no record).
 *  Configured order is preserved; records for unconfigured ids are ignored. */
export function summarizeSuite(configured: readonly string[], records: readonly SuiteProblemRecord[]): SuiteSummary {
  const summary: SuiteSummary = { completed: [], failed: [], missing: [] };
  for (const problemId of configured) {
    const record = records.find((r) => r.problemId === problemId);
    if (record === undefined) summary.missing.push(problemId);
    else if (record.exitCode === 0) summary.completed.push(problemId);
    else summary.failed.push(problemId);
  }
  return summary;
}

/** Operator-readable summary: one line per class, `(none)` when empty. */
export function renderSuiteSummary(summary: SuiteSummary): string {
  const line = (label: string, ids: readonly string[]): string =>
    `suite summary: ${label} — ${ids.length > 0 ? ids.join(', ') : '(none)'}`;
  return [line('completed', summary.completed), line('failed', summary.failed), line('missing', summary.missing)].join(
    '\n',
  );
}
