// packages/core/src/readiness/slice-plan-store.ts — where a slice plan lives (#3813).
//
// Issue runs keep the plan in a trusted issue comment; a brief has no issue, so its plan lives in a
// factory run-state file. resolveSliceGate and the stack recorders go through this one seam.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { parseSlicePlanComment, renderSlicePlanComment } from './slice-plan.js';
import type { SlicePlan } from './slice-plan.js';
import { findSlicePlanComment, upsertSlicePlanComment } from './slice-plan-github.js';

export type SlicePlanLookup =
  | { status: 'not-found' }
  | { status: 'found'; plan: SlicePlan; where: string }
  | { status: 'invalid'; where: string; error: string };

export interface SlicePlanStore {
  find(): Promise<SlicePlanLookup>;
  /** Returns a short label for logs, e.g. `comment 123` or the state file path. */
  save(plan: SlicePlan): Promise<{ where: string }>;
}

export function issueCommentSlicePlanStore(deps: { octokit: Octokit; repo: string; issue: number }): SlicePlanStore {
  const { octokit, repo, issue } = deps;
  return {
    async find() {
      const lookup = await findSlicePlanComment({ octokit, repo, issue });
      if (lookup.status === 'not-found') return lookup;
      const where = `comment ${lookup.commentId} on #${issue}`;
      if (lookup.status === 'invalid') return { status: 'invalid', where, error: lookup.error };
      return { status: 'found', plan: lookup.plan, where };
    },
    async save(plan) {
      const upserted = await upsertSlicePlanComment({ octokit, repo, issue, plan });
      return { where: `comment ${upserted.commentId}` };
    },
  };
}

export function fileSlicePlanStore(file: string): SlicePlanStore {
  return {
    async find() {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'not-found' };
        throw error;
      }
      const parsed = parseSlicePlanComment(text);
      if (parsed === null) return { status: 'invalid', where: file, error: 'slice plan marker is missing' };
      if (!parsed.ok) return { status: 'invalid', where: file, error: parsed.error };
      return { status: 'found', plan: parsed.plan, where: file };
    },
    async save(plan) {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, renderSlicePlanComment(plan));
      renameSync(tmp, file);
      return { where: file };
    },
  };
}
