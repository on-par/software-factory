// src/utils/in-place.ts — in-place workspace mode (#3904): run the pipeline in the current
// checkout instead of a factory worktree. The clone is the isolation boundary, so the checkout
// must be clean and at the fetched default-branch tip, and nothing here ever deletes anything.

import type { EventKind } from '../events/kinds.js';
import type { RemoteBranchRecord } from '../types/index.js';
import type { PrLookup } from '../phases/ship.js';
import { execGit } from './git-exec.js';
import {
  defaultRemoteBase,
  detectRemoteBranch,
  gitFetch,
  type WorktreeSetupOptions,
  type WorktreeSetupResult,
} from './index.js';

export type InPlaceCheckoutProblem =
  | { kind: 'dirty'; files: string[]; message: string }
  | { kind: 'wrong-branch'; current: string; expected: string; message: string }
  | { kind: 'not-at-tip'; head: string; tip: string; expected: string; message: string };

const MAX_LISTED_FILES = 20;

function porcelainPath(line: string): string {
  const path = line.slice(3);
  const arrow = path.indexOf(' -> ');
  return arrow === -1 ? path : path.slice(arrow + 4);
}

async function revParse(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execGit(['rev-parse', ...args], { cwd: repoRoot });
  return stdout.trim();
}

/** Why the checkout cannot host an in-place run, or null when it is clean and at origin/<default>. */
export async function checkInPlaceCheckout(repoRoot: string): Promise<InPlaceCheckoutProblem | null> {
  await gitFetch(repoRoot);
  const { stdout: status } = await execGit(['status', '--porcelain'], { cwd: repoRoot });
  const files = status
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(porcelainPath);
  if (files.length > 0) {
    const listed = files.slice(0, MAX_LISTED_FILES).join(', ');
    const more = files.length > MAX_LISTED_FILES ? ` (+${files.length - MAX_LISTED_FILES} more)` : '';
    return {
      kind: 'dirty',
      files,
      message: `in-place run refused: the checkout has uncommitted changes: ${listed}${more} — commit, stash or discard them, or use a fresh clone`,
    };
  }
  const expected = await defaultRemoteBase(repoRoot);
  const defaultName = expected.replace(/^origin\//, '');
  const current = await revParse(repoRoot, ['--abbrev-ref', 'HEAD']);
  if (current !== defaultName) {
    return {
      kind: 'wrong-branch',
      current,
      expected: defaultName,
      message: `in-place run refused: the checkout is on '${current}' (detached HEAD when 'HEAD'), not the default branch '${defaultName}' — git switch ${defaultName}`,
    };
  }
  const head = await revParse(repoRoot, ['HEAD']);
  const tip = await revParse(repoRoot, [`${expected}^{commit}`]);
  if (head !== tip) {
    return {
      kind: 'not-at-tip',
      head,
      tip,
      expected,
      message: `in-place run refused: HEAD ${head.slice(0, 8)} is not the fetched ${expected} tip ${tip.slice(0, 8)} — git reset --hard ${expected} in a disposable clone`,
    };
  }
  return null;
}

/** Switches the checkout to the factory branch, cut from origin/<default> (or the branch's open
 *  PR head). Re-checks readiness first to guard a race with the preflight. Never deletes. */
export async function setupInPlaceCheckout(
  repoRoot: string,
  branch: string,
  log?: (type: EventKind, msg: string) => void,
  opts?: Pick<WorktreeSetupOptions, 'findOpenPr'>,
): Promise<WorktreeSetupResult> {
  const problem = await checkInPlaceCheckout(repoRoot);
  if (problem) throw new Error(problem.message);
  let openPrBranch = false;
  let remoteBranch: RemoteBranchRecord | null = null;
  const remoteSha = await detectRemoteBranch(repoRoot, branch);
  if (remoteSha) {
    remoteBranch = { sha: remoteSha };
    let prText = 'open PR not checked';
    if (opts?.findOpenPr) {
      let lookup: PrLookup;
      try {
        lookup = await opts.findOpenPr(branch);
      } catch (err) {
        lookup = { status: 'error', detail: err instanceof Error ? err.message : String(err) };
      }
      if (lookup.status === 'found') {
        remoteBranch.prNumber = lookup.prNumber;
        openPrBranch = true;
        prText = `open PR #${lookup.prNumber} — continuing on origin/${branch}`;
      } else if (lookup.status === 'absent') {
        prText = 'no open PR';
      } else {
        prText = `open PR lookup failed: ${lookup.detail}`;
      }
    }
    log?.('remote-branch-preexisting', `origin/${branch} already exists @ ${remoteSha}; ${prText}`);
  }
  const base = openPrBranch ? `origin/${branch}` : await defaultRemoteBase(repoRoot);
  try {
    await execGit(['switch', '--no-track', '-c', branch, base], { cwd: repoRoot });
  } catch (err) {
    const stderr = ((err as { stderr?: unknown })?.stderr ?? (err instanceof Error ? err.message : String(err)))
      .toString()
      .trim();
    throw new Error(
      `in-place run refused: could not create branch '${branch}' in the checkout (${stderr}) — delete the local branch or use a fresh clone`,
      { cause: err },
    );
  }
  const head = await revParse(repoRoot, ['--verify', 'HEAD']);
  log?.('worktree-base', `in-place: switched ${repoRoot} to ${branch} from ${base} @ ${head}`);
  return { base, head, remoteBranch };
}
