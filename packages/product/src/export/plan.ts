// packages/product/src/export/plan.ts — gate-checked export planning (#476).

import type { Epic, Story } from '@on-par/contracts';

import type { HandoffDecision, ProposerArtifacts } from '../readiness/index.js';
import type { DesignBundle } from './bundle.js';
import { buildDesignBundle } from './bundle.js';

export interface ExportPlan {
  epic: Epic;
  stories: readonly Story[];
  bundle: DesignBundle;
}

export type ExportPlanResult = { ok: true; plan: ExportPlan } | { ok: false; blockers: readonly string[] };

/** Gates export on the human handoff decision, then assembles the ExportPlan. */
export function planExport(artifacts: ProposerArtifacts, decision: HandoffDecision): ExportPlanResult {
  if (!decision.ok) {
    return { ok: false, blockers: decision.blockers };
  }

  const { decomposition } = artifacts;
  if (decomposition === undefined) {
    return { ok: false, blockers: ['export needs a decomposition — nothing to file'] };
  }

  return {
    ok: true,
    plan: {
      epic: decomposition.epic,
      stories: decomposition.stories,
      bundle: buildDesignBundle(artifacts, decision.report),
    },
  };
}
