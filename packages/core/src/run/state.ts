// src/run/state.ts — The persisted IssueRunState record (#972). One JSON file per
// issue under getFactoryPaths(...).runs. `repo` is resolved from the run's own
// worktree, not from dirname(file): a registry-attached repo may keep its factory
// state root outside the checkout (#843/#894), so the state file's directory is not
// reliably inside the repo it describes. The resolver and the remote parser are the
// same ones FactoryEvent.repo uses (#971/#984) — one slug source for both envelopes.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { resolveRepoSlug } from '../logger/repo-slug.js';
import type { IssueRunState } from '../types/index.js';

/** Path of one issue's persisted run state inside `runsDir`
 *  (`getFactoryPaths(repoRoot).runs`). */
export function runStateFile(runsDir: string, issue: number): string {
  return resolve(runsDir, `issue-${issue}.json`);
}

/** Persists `state`, filling `repo` from the run's worktree when the caller did not
 *  supply one. Returns the record as persisted, so a caller can see the resolved slug.
 *  An unresolvable slug omits the key rather than writing a placeholder. */
export async function writeIssueRunState(file: string, state: IssueRunState): Promise<IssueRunState> {
  const repo = state.repo ?? resolveRepoSlug(state.worktree) ?? undefined;
  const record: IssueRunState = repo === undefined ? { ...state } : { ...state, repo };
  // `repo` must be absent, not undefined, in the JSON: JSON.stringify drops undefined
  // values, so the two shapes serialize identically — keep it that way.

  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, file);
  return record;
}

/** Reads one issue's persisted run state, or null when the file is missing,
 *  unreadable, or not a JSON object. Never throws. `repo` is surfaced when the record
 *  carries a non-empty string and is absent otherwise, so a record written before
 *  #972 reads back with `repo === undefined`. */
export async function readIssueRunState(file: string): Promise<IssueRunState | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as IssueRunState;
  if (typeof record.repo !== 'string' || record.repo.length === 0) {
    const { repo: _dropped, ...rest } = record;
    return rest as IssueRunState;
  }
  return record;
}
