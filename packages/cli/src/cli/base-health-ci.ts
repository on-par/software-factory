// packages/cli/src/cli/base-health-ci.ts — base health port with the strict GitHub CI lookup bound in (#3186)

import type { Octokit } from '@octokit/rest';
import { checkBaseHealth, fetchRequiredChecksVerdict, logEvent } from '@on-par/factory-core/internal';

type RequiredChecksVerdict = Awaited<ReturnType<typeof fetchRequiredChecksVerdict>>;

interface BaseChecksOptions {
  checks?: readonly string[];
  events?: string;
  lane?: string;
}

const reported = new Set<string>();

/** Test-only: forget which failed push workflows were already reported. */
export function resetBasePushWorkflowReports(): void {
  reported.clear();
}

/**
 * The base verdict shared by the base-hold gate and base health (#3287, #3290): only code-health checks decide it.
 * A failed non-code push workflow (Release, deploy) logs one `base_push_workflow_failed` event per repo, SHA and workflow.
 */
export function baseChecksVerdict(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: BaseChecksOptions,
): (sha: string) => Promise<RequiredChecksVerdict> {
  return (sha) =>
    fetchRequiredChecksVerdict(
      octokit,
      { owner, repo, branch: 'main', sha },
      {
        pushFallback: true,
        checks: opts.checks,
        onPushWorkflowFailed: (f) => {
          const key = `${owner}/${repo}@${f.sha}:${f.workflow}`;
          if (reported.has(key)) return;
          reported.add(key);
          if (!opts.events) return;
          logEvent(
            opts.events,
            'base_push_workflow_failed',
            opts.lane ?? '-',
            `push workflow ${f.workflow} ${f.conclusion} on ${f.sha.slice(0, 8)}; not a code-health check, base not held`,
            { lane: opts.lane },
          );
        },
      },
    );
}

export function baseHealthWithCi(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: BaseChecksOptions = {},
): (opts: Parameters<typeof checkBaseHealth>[0]) => ReturnType<typeof checkBaseHealth> {
  return (healthOpts) =>
    checkBaseHealth({
      ...healthOpts,
      // The gate in run.ts uses the same helper, so both see the same verdict on 403-protection repos (#3287, #3290).
      requiredChecksVerdict: baseChecksVerdict(octokit, owner, repo, opts),
    });
}
