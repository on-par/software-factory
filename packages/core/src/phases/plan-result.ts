import type { BuildRoutePin } from '../config/repo.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import type { DesignArtifact } from '../types/index.js';

export interface PlanResult {
  ok: boolean;
  route: BuildRoutePin;
  specPath: string;
  model: string;
  escalate?: string;
  /** Set when the planner could not write its spec (#3269): `ok` is false and the caller parks `config`. */
  parkReason?: 'config';
  designArtifact: DesignArtifact | null;
  /** Set by either file-mode size gate (pre-flight or post-plan build-scope) when the oversized
   *  issue was decomposed into real filed sub-issues. `ok` stays false: this run is over, but the caller can
   *  continue the lane with these children instead of parking (#823). */
  decomposed?: { childIssues: number[] };
  /** Set only by the post-plan build-scope gate in sizeGate.mode 'slice' (ADR-0147) when the whole
   *  issue was sliced and its slice plan comment recorded. `ok` stays false: this run ends before
   *  BUILD, and the next run plans the current slice from the comment. */
  sliced?: { sliceCount: number };
  /** Set on an ok result when PLAN planned one slice of a sliced issue (ADR-0147). SHIP titles the PR
   *  from it, and runIssue records the PR in the slice plan comment. */
  slice?: { plan: SlicePlan; index: number };
  /** ADR-0161: set with `ok: false` when the stack slice below is not yet approved or merged. */
  stackWait?: { index: number; count: number; prNumber: number };
}
