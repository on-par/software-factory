// packages/cli/src/cli/ship-options.ts — shipIssue's option bag and the --base-branch flag helpers (#3764)
import type { SizeGateMode } from '@on-par/factory-core';
import { CliExitError } from './errors.js';

export interface ShipIssueOptions {
  product?: string;
  autoRework?: boolean;
  interactive?: boolean;
  sandbox?: boolean;
  approvePlan?: boolean;
  branchPrefix?: string;
  /** `run-issue --size-gate` (ADR-0147); undefined defers to sizeGate.mode in the config. */
  sizeGate?: SizeGateMode;
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

/** A message when `--base-branch` is combined with a flag it cannot work with, else undefined. */
export function baseBranchConflict(opts: {
  baseBranch?: string;
  sizeGate?: string;
  runChildren?: boolean;
  workspace?: string;
}): string | undefined {
  const { baseBranch, sizeGate, runChildren, workspace } = opts;
  if (baseBranch === undefined) return undefined;
  if (workspace !== undefined) {
    return 'factory: --base-branch needs a factory worktree — drop --workspace or drop --base-branch';
  }
  if ((sizeGate !== undefined && sizeGate !== 'off' && sizeGate !== 'stack') || runChildren) {
    return 'factory: --base-branch runs with the size gate off or stack — drop --size-gate/--run-children or drop --base-branch';
  }
  return undefined;
}

/** The remote-tracking ref a --base-branch run starts from. */
export function baseRemoteRef(baseBranch: string | undefined): string | undefined {
  return baseBranch === undefined ? undefined : `origin/${baseBranch}`;
}
