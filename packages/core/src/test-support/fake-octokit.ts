export interface FakeOctokitOptions {
  prBodies?: string[];
  statuses?: object[];
}

export function fakeOctokit(opts: FakeOctokitOptions = {}) {
  const calls = {
    createCommitStatus: [] as { state: string; description: string; sha?: string; context?: string }[],
    listCommitStatusesForRef: [] as Record<string, unknown>[],
    pullsUpdate: [] as { body: string }[],
  };
  const repos = {
    createCommitStatus: async (args: { state: string; description: string }) => {
      calls.createCommitStatus.push(args);
      return {};
    },
    listCommitStatusesForRef: async (args: Record<string, unknown>) => {
      calls.listCommitStatusesForRef.push(args);
      return { data: opts.statuses ?? [] };
    },
  };
  const pulls = {
    get: async () => ({ data: { body: opts.prBodies?.shift() ?? 'Original body' } }),
    update: async (args: { body: string }) => {
      calls.pullsUpdate.push(args);
      return {};
    },
  };
  const octokit: any = { rest: { repos, pulls } };
  return { octokit, calls };
}
