import type { BuildRoutePin } from '../config/repo.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import type { DesignArtifact } from '../types/index.js';

export interface PlanResult {
  ok: boolean;
  route: BuildRoutePin;
  specPath: string;
  model: string;
  escalate?: string;
  parkReason?: 'config';
  designArtifact: DesignArtifact | null;
  sliced?: { sliceCount: number };
  slice?: { plan: SlicePlan; index: number };
}
