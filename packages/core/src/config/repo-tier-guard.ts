// src/config/repo-tier-guard.ts — Refuse repo tiers that would route to a model that may train on prompts (#2899)

import type { ModelsConfig } from './index.js';

/** Throws when a repo `tiers` entry names a `trainsOnPrompts` model. Pins are not checked, so they keep working. */
export function assertTierMayRoute(tierName: string, id: string, def: ModelsConfig['models'][string]): void {
  if (!def.trainsOnPrompts) return;
  throw new Error(
    `.factory/config.json: tier '${tierName}' lists '${id}', whose provider may train on prompts; tiers never route to it. Pin it instead (models.pins.plan/build/checker/triage)`,
  );
}
