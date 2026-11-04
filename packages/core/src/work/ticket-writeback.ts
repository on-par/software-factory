// packages/core/src/work/ticket-writeback.ts — write-back to a Linear ticket: closing trailer, comments, labels (#3894).

import type { LinearQueueLifecycleClient } from '../queue/linear-queue-lifecycle.js';
import type { SlicePlanStore } from '../readiness/slice-plan-store.js';
import { renderSlicePlanComment } from '../readiness/slice-plan.js';
import { GITHUB_ISSUE_SOURCE } from './github-issue.js';
import type { WorkRequest } from './index.js';
import { LINEAR_ISSUE_SOURCE } from './linear-issue.js';
import type { WorkKey } from './work-key.js';

export type TicketTrackerKind = 'github' | 'linear';
export type LinearTicketClient = Pick<LinearQueueLifecycleClient, 'findIssue' | 'addComment'>;
export interface TicketWriteback {
  comment(key: WorkKey, body: string): Promise<void>;
  labels(key: WorkKey): Promise<string[]>;
}

/** The tracker a work request lives in; undefined for a work source with no ticket (e.g. a local brief). */
export function ticketTrackerOf(work: Pick<WorkRequest, 'kind'> | undefined): TicketTrackerKind | undefined {
  if (work === undefined || work.kind === GITHUB_ISSUE_SOURCE) return 'github';
  if (work.kind === LINEAR_ISSUE_SOURCE) return 'linear';
  return undefined;
}

/** The Linear issue key of a work request; undefined for any other work. */
export function ticketKeyOf(work: Pick<WorkRequest, 'kind' | 'key'> | undefined): WorkKey | undefined {
  return ticketTrackerOf(work) === 'linear' && work?.key !== undefined ? work.key : undefined;
}

/** The single PR-body trailer line: closes the ticket on the final slice, otherwise only references it. */
export function closesTrailer(tracker: TicketTrackerKind, key: WorkKey, finalSlice: boolean): string {
  if (tracker === 'github') return finalSlice ? `Closes #${key}` : `Part of #${key}`;
  return finalSlice ? `Fixes ${key}` : `Part of ${key}`;
}

/** Linear renders HTML comments literally, so factory markers are removed before posting. */
function stripMarkers(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '').trim();
}

export function createLinearTicketWriteback(client: LinearTicketClient): TicketWriteback {
  async function find(key: WorkKey) {
    const issue = await client.findIssue(key);
    if (!issue) throw new Error(`Linear issue ${key} not found`);
    return issue;
  }
  return {
    async comment(key, body) {
      const issue = await find(key);
      await client.addComment(issue.id, stripMarkers(body));
    },
    async labels(key) {
      const issue = await find(key);
      return issue.labels.map((l) => l.name);
    },
  };
}

/** Posts a comment to the ticket; never throws. A missing writeback or a failed post only warns. */
export async function postTicketComment(
  writeback: TicketWriteback | undefined,
  key: WorkKey,
  body: string,
  warn: (msg: string) => void,
): Promise<boolean> {
  if (!writeback) {
    warn(`no Linear writeback is wired; could not post to ${key}`);
    return false;
  }
  try {
    await writeback.comment(key, body);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`could not post to Linear issue ${key}: ${message}`);
    return false;
  }
}

/** A slice-plan store that also mirrors each saved plan to the ticket; the inner store stays the source of truth. */
export function mirrorSlicePlanToTicket(
  store: SlicePlanStore,
  writeback: TicketWriteback | undefined,
  key: WorkKey,
  warn: (msg: string) => void,
): SlicePlanStore {
  return {
    find: () => store.find(),
    async save(plan) {
      const saved = await store.save(plan);
      await postTicketComment(writeback, key, renderSlicePlanComment(plan), warn);
      return saved;
    },
  };
}
