// packages/cli/src/cli/base-health-ci.ts — base health port with the strict GitHub CI lookup bound in (#3186)

import type { Octokit } from '@octokit/rest';
import { checkBaseHealth, fetchRequiredChecksVerdict } from '@on-par/factory-core/internal';

export function baseHealthWithCi(
  octokit: Octokit,
  owner: string,
  repo: string,
  checks?: readonly string[],
): (opts: Parameters<typeof checkBaseHealth>[0]) => ReturnType<typeof checkBaseHealth> {
  return (opts) =>
    checkBaseHealth({
      ...opts,
      requiredChecksVerdict: (sha) =>
        fetchRequiredChecksVerdict(
          octokit,
          { owner, repo, branch: 'main', sha },
          { pushFallback: true, checks, log: opts.log },
        ),
    });
}
