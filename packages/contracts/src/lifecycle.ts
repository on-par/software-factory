// src/lifecycle.ts — Lane lifecycle event: the engine's in-process progress seam (#591).
import { z } from 'zod';

/** The four boss-worker-checker phases, lower-cased to match FactoryEvent.phase. */
export const LANE_LIFECYCLE_PHASES = ['plan', 'build', 'check', 'ship'] as const;

export const LaneLifecyclePhaseSchema = z.enum(LANE_LIFECYCLE_PHASES);
export const LaneLifecycleStatusSchema = z.enum(['started', 'progress', 'done', 'failed']);

export const LaneLifecycleEventSchema = z.object({
  /** ISO-8601, same clock format as FactoryEvent.ts. */
  ts: z.string(),
  laneId: z.string(),
  issueId: z.string(),
  phase: LaneLifecyclePhaseSchema,
  status: LaneLifecycleStatusSchema,
  detail: z.string(),
  worktreePath: z.string(),
});

export type LaneLifecyclePhase = z.infer<typeof LaneLifecyclePhaseSchema>;
export type LaneLifecycleStatus = z.infer<typeof LaneLifecycleStatusSchema>;
export type LaneLifecycleEvent = z.infer<typeof LaneLifecycleEventSchema>;
