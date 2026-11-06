// packages/cli/src/cli/run-until-done-command.ts — `factory run --issue <n>`: the command around runUntilDone (#3908)

import { existsSync } from 'node:fs';

import { getFactoryPaths, resolveMergePolicy, workKeyFromIssue } from '@on-par/factory-core';
import { resolveAwaitingCiCapMs } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { availableAgentClis, missingAgentCliMessage, notInitializedMessage } from './first-run.js';
import { withRepoRunLock } from './repo-run-lock.js';
import { withRunReport } from './run-report.js';
import { exitForUntilDone, runUntilDone, validateUntilDoneFlags, type UntilDoneFlagOptions } from './run-until-done.js';
import { untilDoneDepsFrom } from './run-until-done-wiring.js';
import { shipRuntime } from './ship-runtime.js';

export interface UntilDoneCommandOptions extends Omit<UntilDoneFlagOptions, 'issue'> {
  autoMerge?: boolean | undefined;
  branchPrefix?: string | undefined;
}

/** `factory run --issue <n>`: ships the issue (or picks up its open PR), then merges it, runs feedback rounds and waits per `--wait`. */
export async function cmdRunUntilDone(
  issue: number,
  opts: UntilDoneCommandOptions,
  branchPrefixOrExit: (raw: string | undefined, configPath: string) => string,
): Promise<void> {
  const { wait, maxWaitMs } = validateUntilDoneFlags({ ...opts, issue: String(issue) });
  const runtime = shipRuntime();
  const shell = runtime.resolveShellOps({});
  if (availableAgentClis(runtime.resolveCoreOps({}).isCommandAvailable).length === 0) {
    throw new CliExitError(`factory: ${missingAgentCliMessage()}`, 2);
  }
  const repoRoot = await runtime.getRepoRoot(shell);
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.root)) throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  const branchPrefix = branchPrefixOrExit(opts.branchPrefix, paths.config);
  const config = runtime.resolveConfigLoaders({}).loadFactoryConfigForRepo(paths.config);
  const policy = resolveMergePolicy(config, process.env, {
    ...(opts.autoMerge === undefined ? {} : { auto: opts.autoMerge }),
    ...(opts.admin ? { admin: true } : {}),
  });
  const mergeTimeoutMs = resolveAwaitingCiCapMs(config);

  const reportCtx = { issue, repoRoot, paths, getRepo: () => runtime.getGitHubRepo(shell) };
  await withRunReport(
    { json: opts.json, ...(opts.export === undefined ? {} : { export: opts.export }) },
    reportCtx,
    (report) =>
      withRepoRunLock(
        paths,
        'factory run --issue',
        async () => {
          const repo = await runtime.getGitHubRepo(shell);
          const deps = untilDoneDepsFrom({
            issue,
            octokit: runtime.getOctokit(shell),
            repo,
            repoRoot,
            paths,
            config,
            branchPrefix,
            admin: policy.admin,
            mergeTimeoutMs,
            onOutcome: (o) => report.recordOutcome(o),
            recordMerge: (m) => report.recordMerge(m),
            log: (line) => console.error(`factory: ${line}`),
          });
          const input = { issue, wait, maxWaitMs, autoMerge: policy.auto, admin: policy.admin, mergeTimeoutMs };
          let result;
          try {
            result = await runUntilDone(input, deps);
          } catch (err) {
            if (err instanceof runtime.IssueSkippedError) return report.recordError(err);
            throw err;
          }
          report.recordLifecycle(result);
          exitForUntilDone(result, issue);
        },
        { scope: { kind: 'issue', key: workKeyFromIssue(issue) } },
      ),
  );
}

/** cmdRunUntilDone bound to the CLI's branch-prefix resolver, as the program's handler. */
export function cmdRunUntilDoneWith(
  branchPrefixOrExit: (raw: string | undefined, configPath: string) => string,
): (issue: number, opts: UntilDoneCommandOptions) => Promise<void> {
  return (issue, opts) => cmdRunUntilDone(issue, opts, branchPrefixOrExit);
}
