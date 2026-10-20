// src/types/escalate.ts — planner ESCALATE kinds (#3275)
import type { FactoryEvent } from './index.js';

/** Why the planner escalated: missing information, a contradiction, or a size/split request. */
export type EscalateKind = NonNullable<FactoryEvent['escalateKind']>;
