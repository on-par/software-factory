// src/config/repo-registry.ts — Load-time validation of a repo's `models.registry` entries

import { approvedIntermediaryNames, directDeepSeekReason } from './intermediaries.js';
import type { ModelsConfig } from './index.js';

type ModelDef = ModelsConfig['models'][string];

/** Throw naming the offending `models.registry.<id>` when an entry redefines a packaged model id, declares an unknown
 *  harness, or reaches DeepSeek's first-party API (ADR-0163: DeepSeek only through an approved intermediary). */
export function assertRegistryEntries(
  models: ModelsConfig,
  registry: Record<string, ModelDef>,
  validHarnesses: readonly string[],
): void {
  for (const [id, def] of Object.entries(registry)) {
    if (Object.hasOwn(models.models, id)) {
      throw new Error(
        `.factory/config.json: models.registry.${id} redefines packaged model '${id}'; packaged model ids cannot be redefined. Register it under a new id (for example '${id}-custom') and pin or tier that id instead`,
      );
    }
    if (def.harness !== undefined && !validHarnesses.includes(def.harness)) {
      throw new Error(
        `.factory/config.json: models.registry.${id} declares unknown harness '${def.harness}' (valid harnesses: ${validHarnesses.join(', ')})`,
      );
    }
    const deepSeekReason = directDeepSeekReason(def);
    if (deepSeekReason) {
      throw new Error(
        `.factory/config.json: models.registry.${id} reaches DeepSeek's first-party API (${deepSeekReason}); ADR-0163 allows DeepSeek models only through an approved zero-retention intermediary (${approvedIntermediaryNames().join(', ')}). Use an 'openrouter/deepseek/...' or 'opencode-go/...' providerModel instead`,
      );
    }
  }
}
