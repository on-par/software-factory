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
  ticketWriteback?: TicketWriteback;
}

export interface LinearRunWriteback {
  park(input: Omit<ParkCommentInput, 'issue'>): Promise<boolean>;
  environment(env: Parameters<typeof renderEnvironmentReleaseComment>[0]): Promise<boolean>;
  slicePlanStore: SlicePlanStore | undefined;
}

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
