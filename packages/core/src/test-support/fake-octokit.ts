const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

export interface FakeOctokitOptions {
  ref?: 'none' | 'exists';
  readBack?: 'ok' | 'missing';
  readBackSize?: number;
  updateFails?: number;
  prBodies?: string[];
  statuses?: object[];
}

export function fakeOctokit(opts: FakeOctokitOptions = {}) {
  let updateFails = opts.updateFails ?? 0;
  const calls = {
    getRef: [] as Record<string, unknown>[],
    getCommit: [] as Record<string, unknown>[],
    createBlob: [] as Record<string, unknown>[],
    createTree: [] as Record<string, unknown>[],
    createCommit: [] as Record<string, unknown>[],
    createRef: [] as Record<string, unknown>[],
    updateRef: [] as Record<string, unknown>[],
    getContent: [] as Record<string, unknown>[],
    createCommitStatus: [] as { state: string; description: string; sha?: string; context?: string }[],
    listCommitStatusesForRef: [] as Record<string, unknown>[],
    pullsUpdate: [] as { body: string }[],
  };
  const git = {
    getRef: async (args: Record<string, unknown>) => {
      calls.getRef.push(args);
      if (opts.ref !== 'exists') throw httpError(404);
      return { data: { object: { sha: 'parentsha' } } };
    },
    getCommit: async (args: Record<string, unknown>) => {
      calls.getCommit.push(args);
      return { data: { tree: { sha: 'parenttree' } } };
    },
    createBlob: async (args: Record<string, unknown>) => {
      calls.createBlob.push(args);
      return { data: { sha: 'blobsha' } };
    },
    createTree: async (args: Record<string, unknown>) => {
      calls.createTree.push(args);
      return { data: { sha: 'treesha' } };
    },
    createCommit: async (args: Record<string, unknown>) => {
      calls.createCommit.push(args);
      return { data: { sha: 'commitsha000000' } };
    },
    createRef: async (args: Record<string, unknown>) => {
      calls.createRef.push(args);
      return {};
    },
    updateRef: async (args: Record<string, unknown>) => {
      calls.updateRef.push(args);
      if (updateFails-- > 0) throw httpError(422);
      return {};
    },
  };
  const repos = {
    getContent: async (args: { path: string }) => {
      calls.getContent.push(args);
      if (opts.readBack === 'missing') throw httpError(404);
      return { data: { type: 'file', size: opts.readBackSize ?? 4 } };
    },
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
  const octokit: any = { rest: { git, repos, pulls } };
  return { octokit, calls };
}
