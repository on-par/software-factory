// packages/cli/src/cli/land-runtime.ts — accessor for index.ts's per-invocation ops, so the land flow reads them live without a runtime import cycle (#2784)

import type { Octokit } from '@octokit/rest';
import type { CliDeps, ConfigLoaderKey, GitOpKey, InternalOpKey, LaneParkError, ShellOpKey } from './index.js';

/** index.ts's per-invocation ops, read at call time so cmdLand/main() deps injection reaches the land flow. */
export interface LandRuntime {
  configLoaders: Required<Pick<CliDeps, ConfigLoaderKey>>;
  gitOps: Required<Pick<CliDeps, GitOpKey>>;
  internalOps: Required<Pick<CliDeps, InternalOpKey>>;
  shellOps: Required<Pick<CliDeps, ShellOpKey>>;
  getOctokit: () => Octokit;
  errorDetail: (err: unknown) => string;
  worktreePathFor: (repoRoot: string, ghRepo: string, issueNum: number, prefix?: string) => string;
  LaneParkError: typeof LaneParkError;
}

let get: (() => LandRuntime) | undefined;

export function setLandRuntime(fn: () => LandRuntime): void {
  get = fn;
}

export function landRuntime(): LandRuntime {
  if (!get) throw new Error('land runtime not registered: import ./index.js first');
  return get();
}
