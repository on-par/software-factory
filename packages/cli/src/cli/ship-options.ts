// packages/cli/src/cli/ship-options.ts — shipIssue's option bag and the --base-branch flag helpers (#3764)
import {
  resolveSizeGateMaxSlices,
  resolveSizeGateMode,
  type FactoryConfig,
  type SizeGateMode,
} from '@on-par/factory-core';
import { isExplicitStackMode, type PrerequisiteStackTarget } from '@on-par/factory-core/internal';
import { CliExitError } from './errors.js';

export interface ShipSizeGate {
  noPr: boolean;
  sizeGateMode: SizeGateMode;
  explicitStack: boolean;
  maxSlices: number;
}

/** The size gate for one ship (ADR-0147). `--no-pr` never files child issues or slice PRs and `--in-place` builds one
 *  branch in one checkout (#3904), so both turn it off; `--base-branch` turns it off unless stack mode was asked for
 *  or the base is a prerequisite stack's branch (#3916). */
export function resolveShipSizeGate(opts: ShipIssueOptions, config: FactoryConfig): ShipSizeGate {
  const noPr = opts.pr === false;
  const gateOff = noPr || opts.inPlace === true || baseBranchGateOff(opts);
  const sizeGateMode = gateOff ? 'off' : (opts.sizeGate ?? resolveSizeGateMode(config));
  const explicitStack =
    sizeGateMode === 'stack' &&
    (opts.sizeGate !== undefined ? opts.explicitStack === true : isExplicitStackMode(config));
  return { noPr, sizeGateMode, explicitStack, maxSlices: opts.maxSlices ?? resolveSizeGateMaxSlices(config) };
}

export interface ShipIssueOptions {
  parkOverBudget?: boolean;
  product?: string;
  autoRework?: boolean;
  interactive?: boolean;
  sandbox?: boolean;
  approvePlan?: boolean;
  branchPrefix?: string;
  /** `run-issue --size-gate` (ADR-0147); undefined defers to sizeGate.mode in the config. */
  sizeGate?: SizeGateMode;
  /** #3832: true when stack came from --stack or --size-gate stack; a defaulted or aliased stack still adopts an open PR. */
  explicitStack?: boolean;
  /** run-issue --max-slices (ADR-0156); undefined defers to sizeGate.maxSlices. */
  maxSlices?: number;
  /** `--pr-classifier` / `--no-pr-classifier` (#1724); undefined defers to config/env. */
  prClassifier?: boolean;
  /** --draft-pr / --no-draft-pr (#3449); undefined defers to run.pr.draft. */
  draftPr?: boolean;
  /** `--no-pr` sets false: stop after a clean CHECK with no GitHub writes; undefined = ship as usual. */
  pr?: boolean;
  /** --base-branch (#3764): start from origin/<ref> and open the PR against <ref>; undefined = default branch. */
  baseBranch?: string;
  /** The open prerequisite PR this issue is stacked on (#3916); `baseBranch` is its branch and the size gate stays on. */
  prerequisiteStack?: PrerequisiteStackTarget;
  /** --in-place / FACTORY_WORKSPACE=in-place (#3904): run in the current checkout, no worktree */
  inPlace?: boolean;
  /** run-issue only, from FACTORY_BASE_HEALTH_REPAIR=1: a confirmed red pre-PLAN base enters PLAN instead of releasing. */
  baseHealthRepair?: boolean;
}

/** The explicit base-repair signal for `run-issue`. */
export const BASE_HEALTH_REPAIR_ENV = 'FACTORY_BASE_HEALTH_REPAIR';

/** True only for the exact string `1`. Unset, empty, `0`, `true`, ` 1` and every other value are off (fail closed). */
export function baseHealthRepairRequested(env: NodeJS.ProcessEnv): boolean {
  return env[BASE_HEALTH_REPAIR_ENV] === '1';
}

const FORBIDDEN_CHARS = /[\s~^:?*[\\]/;

function hasControlChar(raw: string): boolean {
  return [...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
}

/** Returns `raw` when it is usable as a git branch name, undefined otherwise. No trimming, no `origin/` stripping. */
export function parseBaseBranch(raw: string): string | undefined {
  if (raw.trim() === '' || raw.startsWith('-') || raw === '@') return undefined;
  if (FORBIDDEN_CHARS.test(raw) || hasControlChar(raw) || raw.includes('..') || raw.includes('@{')) return undefined;
  if (raw.startsWith('/') || raw.endsWith('/') || raw.includes('//')) return undefined;
  if (raw.endsWith('.') || raw.endsWith('.lock')) return undefined;
  if (raw.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) return undefined;
  return raw;
}

/** Validates `--base-branch`; an invalid value exits 2 before any worktree or PR exists. */
export function baseBranchOrExit(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseBaseBranch(raw);
  if (parsed === undefined) {
    throw new CliExitError(
      `factory: invalid --base-branch '${raw}' — expected an existing branch name (not empty, not starting with '-')`,
      2,
    );
  }
  return parsed;
}

/** `--in-place` wins; else FACTORY_WORKSPACE ('worktree' | 'in-place'; unset or empty = worktree). */
export function resolveWorkspaceMode(flag: boolean | undefined, env: NodeJS.ProcessEnv): 'in-place' | 'worktree' {
  if (flag === true) return 'in-place';
  const raw = env.FACTORY_WORKSPACE;
  if (raw === undefined || raw === '' || raw === 'worktree') return 'worktree';
  if (raw === 'in-place') return 'in-place';
  throw new CliExitError(`factory: unknown FACTORY_WORKSPACE '${raw}' — expected 'worktree' or 'in-place'`, 2);
}

/** A message when `--in-place` is combined with a flag it cannot work with, else undefined. */
export function inPlaceConflict(opts: { baseBranch?: string; sizeGate?: string }): string | undefined {
  if (opts.baseBranch !== undefined) {
    return 'factory: --in-place runs on the default branch — drop --base-branch or drop --in-place';
  }
  if (opts.sizeGate === 'stack') {
    return 'factory: --in-place builds one branch in the checkout — drop --stack/--size-gate stack or drop --in-place';
  }
  return undefined;
}

/** A message when `--base-branch` is combined with a flag it cannot work with, else undefined. */
export function baseBranchConflict(opts: {
  baseBranch?: string;
  sizeGate?: string;
  workspace?: string;
}): string | undefined {
  const { baseBranch, sizeGate, workspace } = opts;
  if (baseBranch === undefined) return undefined;
  if (workspace !== undefined) {
    return 'factory: --base-branch needs a factory worktree — drop --workspace or drop --base-branch';
  }
  if (sizeGate !== undefined && sizeGate !== 'off' && sizeGate !== 'stack') {
    return 'factory: --base-branch runs with the size gate off or stack — drop --size-gate or drop --base-branch';
  }
  return undefined;
}

/** The remote-tracking ref a --base-branch run starts from. */
export function baseRemoteRef(baseBranch: string | undefined): string | undefined {
  return baseBranch === undefined ? undefined : `origin/${baseBranch}`;
}

/** True when `--base-branch` turns the size gate off; a prerequisite stack's base keeps it on (#3916). */
export function baseBranchGateOff(opts: ShipIssueOptions): boolean {
  return opts.baseBranch !== undefined && opts.prerequisiteStack === undefined && opts.sizeGate !== 'stack';
}
