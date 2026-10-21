// src/run/steer.ts — Human steer events on the persisted run state (#3400). A steer is a
// validated, append-only record of a human nudging a run, kept on IssueRunState so
// autonomy can be measured later. Pure functions over the state record: nothing here
// mutates its input, and there is no remove or update API by design.

import { z } from 'zod';

import type { IssueRunState } from '../types/index.js';

/** Where a steer came from. Closed list (#3400). */
export const STEER_SOURCES = ['cli', 'bot', 'github-comment'] as const;
export type SteerSource = (typeof STEER_SOURCES)[number];

/** The factory phase the steer applied to. Mirrors FailurePhase. */
export const STEER_PHASES = ['plan', 'build', 'check', 'ship'] as const;
export type SteerPhase = (typeof STEER_PHASES)[number];

export interface SteerEvent {
  /** ISO-8601 timestamp of the steer. */
  ts: string;
  /** Who steered, as free text. Identity format: a GitHub login (`octocat`) for
   *  github-comment and bot sources, and the local git user name or $USER for cli.
   *  Stored as given and never normalised, so later slices may refine the format
   *  without migrating stored events. */
  actor: string;
  source: SteerSource;
  phase: SteerPhase;
  /** One-line, human-readable description of the steer. */
  summary: string;
  /** True when this steer unblocked a stuck run. Absent when unknown. */
  unblocked?: boolean;
}

export class SteerEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SteerEventError';
  }
}

const steerEventSchema = z.strictObject({
  ts: z.iso.datetime({ offset: true }),
  actor: z.string().trim().min(1),
  source: z.enum(STEER_SOURCES),
  phase: z.enum(STEER_PHASES),
  summary: z.string().trim().min(1),
  unblocked: z.boolean().optional(),
});

const NO_STEERS: readonly SteerEvent[] = Object.freeze([]);

function describeSource(input: unknown): string {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).source : undefined;
  return JSON.stringify(value) ?? String(value);
}

/** Validate an unknown value as a SteerEvent; throws SteerEventError when invalid. */
export function parseSteerEvent(input: unknown): SteerEvent {
  const result = steerEventSchema.safeParse(input);
  if (!result.success) {
    const messages = result.error.issues.map((issue) =>
      issue.path.length === 1 && issue.path[0] === 'source'
        ? `invalid steer source ${describeSource(input)}: expected one of ${STEER_SOURCES.join(', ')}`
        : `invalid steer event: ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new SteerEventError(messages.join('; '));
  }
  const { ts, actor, source, phase, summary, unblocked } = result.data;
  return { ts, actor, source, phase, summary, ...(unblocked === undefined ? {} : { unblocked }) };
}

/** The steers recorded on a run, oldest first. */
export function listSteerEvents(state: IssueRunState): readonly SteerEvent[] {
  return state.steers ?? NO_STEERS;
}

/**
 * Append a steer to a run, returning a new state. Append-only: there is no remove or
 * update API by design. An invalid event throws before anything is built, so the input
 * state is never touched.
 */
export function appendSteerEvent(state: IssueRunState, event: unknown): IssueRunState {
  const parsed = parseSteerEvent(event);
  return { ...state, steers: Object.freeze([...listSteerEvents(state), Object.freeze(parsed)]) };
}
