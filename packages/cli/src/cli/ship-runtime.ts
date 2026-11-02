// packages/cli/src/cli/ship-runtime.ts — accessor for index.ts's per-invocation ops, so the ship flow reads them live without a runtime import cycle (#2788)

import type { Octokit } from '@octokit/rest';
import type { writeLocalRunReport } from '@on-par/factory-core';
import type {
  CliDeps,
  ConfigLoaderKey,
  CoreOpKey,
  GitOpKey,
  IssueSkippedError,
  LaneEnvironmentPauseError,
  LaneParkError,
  ShellOpKey,
  readActiveProduct,
  resolveEnvironmentAcquirer,
  resolveLaneBaseUrl,
} from './index.js';
import type { FactoryOctokitOptions } from './octokit.js';

type ConfigLoaders = Required<Pick<CliDeps, ConfigLoaderKey>>;
type GitOps = Required<Pick<CliDeps, GitOpKey>>;
type ShellOps = Required<Pick<CliDeps, ShellOpKey>>;
type CoreOps = Required<Pick<CliDeps, CoreOpKey>>;
type PhaseOps = Required<Pick<CliDeps, 'planPhase' | 'buildPhase' | 'checkPhase' | 'shipPhase'>>;

/** index.ts's per-invocation ops, read at call time so main()/cmdRun deps injection reaches the ship flow. */
export interface ShipRuntime {
  resolveConfigLoaders: (overrides: Partial<ConfigLoaders>) => ConfigLoaders;
  resolveGitOps: (overrides: Partial<GitOps>) => GitOps;
  resolveShellOps: (overrides: Partial<ShellOps>) => ShellOps;
  resolveCoreOps: (overrides: Partial<CoreOps>) => CoreOps;
  resolvePhaseOps: (overrides: Partial<PhaseOps>) => PhaseOps;
  getRepoRoot: (shell: ShellOps) => Promise<string>;
  getGitHubRepo: (shell: ShellOps) => Promise<string>;
  getOctokit: (shell: ShellOps, options?: FactoryOctokitOptions) => Octokit;
  worktreePathFor: (
    repoRoot: string,
    ghRepo: string,
    issueNum: number,
    prefix?: string,
    loaders?: ConfigLoaders,
  ) => string;
  repoConfigFileFor: (repoRoot: string, absPath: string) => { absPath: string; relPath: string };
  isCommandAvailableViaShell: (shell: ShellOps, cmd: string) => boolean;
  readTextFileOrEmpty: (path: string) => string;
  readActiveProduct: typeof readActiveProduct;
  errorDetail: (err: unknown) => string;
  resolveEnvironmentAcquirer: typeof resolveEnvironmentAcquirer;
  resolveLaneBaseUrl: typeof resolveLaneBaseUrl;
  /** The live coreOps.writeLocalRunReport, for runs that pass no per-call override. */
  defaultWriteLocalRunReport: () => typeof writeLocalRunReport;
  LaneParkError: typeof LaneParkError;
  LaneEnvironmentPauseError: typeof LaneEnvironmentPauseError;
  IssueSkippedError: typeof IssueSkippedError;
}

let get: (() => ShipRuntime) | undefined;

export function setShipRuntime(fn: () => ShipRuntime): void {
  get = fn;
}

export function shipRuntime(): ShipRuntime {
  if (!get) throw new Error('ship runtime not registered: import ./index.js first');
  return get();
}
