import { z } from 'zod';

import type { IssueRunState } from '../types/index.js';

export const STEER_SOURCES = ['cli', 'bot', 'github-comment'] as const;
export type SteerSource = (typeof STEER_SOURCES)[number];

export const STEER_PHASES = ['plan', 'build', 'check', 'ship'] as const;
export type SteerPhase = (typeof STEER_PHASES)[number];

export interface SteerEvent {
  ts: string;
  actor: string;
  source: SteerSource;
  phase: SteerPhase;
  summary: string;
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

export function listSteerEvents(state: IssueRunState): readonly SteerEvent[] {
  return state.steers ?? NO_STEERS;
}

export function appendSteerEvent(state: IssueRunState, event: unknown): IssueRunState {
  const parsed = parseSteerEvent(event);
  return { ...state, steers: Object.freeze([...listSteerEvents(state), Object.freeze(parsed)]) };
}
