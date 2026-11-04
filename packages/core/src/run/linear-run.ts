// packages/core/src/run/linear-run.ts — a run's Linear write-back: park, env-failure and slice-plan comments (#3894).

import { renderEnvironmentReleaseComment } from '../phases/environment-release.js';
import type { SlicePlanStore } from '../readiness/slice-plan-store.js';
import type { WorkRequest } from '../work/index.js';
import {
  mirrorSlicePlanToTicket,
  postTicketComment,
  ticketKeyOf,
  type TicketWriteback,
} from '../work/ticket-writeback.js';
import type { RunLogFn } from './attribution.js';
import { renderParkComment, type ParkCommentInput } from './park-comment.js';

export interface LinearRunPorts {
  /** Linear write-back (#3894): park, env-failure and slice-plan comments under a Linear work request. Absent = warn only. */
  ticketWriteback?: TicketWriteback;
}

export interface LinearRunWriteback {
  /** Posts the park comment to the Linear issue; never throws. */
  park(input: Omit<ParkCommentInput, 'issue'>): Promise<boolean>;
  /** Posts the environment-failure comment to the Linear issue; never throws. */
  environment(env: Parameters<typeof renderEnvironmentReleaseComment>[0]): Promise<boolean>;
  /** The slice-plan store, mirrored to the Linear issue on every save. */
  slicePlanStore: SlicePlanStore | undefined;
}

/** The Linear write-back for a run whose work request is a Linear issue; undefined for any other work. */
export function linearRunWriteback(
  work: WorkRequest,
  ports: LinearRunPorts & { slicePlanStore?: SlicePlanStore },
  log: RunLogFn,
): LinearRunWriteback | undefined {
  const { ticketWriteback: writeback, slicePlanStore: store } = ports;
  const warn = (msg: string) => log('environment_warning', msg);
  const key = ticketKeyOf(work);
  if (key === undefined) return undefined;
  return {
    park: (input) => postTicketComment(writeback, key, renderParkComment({ ...input, issue: key }), warn),
    environment: (env) => postTicketComment(writeback, key, renderEnvironmentReleaseComment(env), warn),
    slicePlanStore: store && mirrorSlicePlanToTicket(store, writeback, key, warn),
  };
}
