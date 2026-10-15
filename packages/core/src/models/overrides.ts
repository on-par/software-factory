// src/models/overrides.ts — Env model overrides and retired-model hints

import { retiredModels } from '@on-par/factory-config';

import type { ModelRegistry } from './index.js';

export interface ModelOverrides {
  plan?: string;
  build?: string;
}

/** Suffix for an unknown-model error when the id is a retired packaged model; '' otherwise. */
export function retiredModelHint(id: string): string {
  const retired = Object.hasOwn(retiredModels, id) ? retiredModels[id] : undefined;
  return retired ? `; '${id}' was removed under ${retired.adr}; use '${retired.replacement}'` : '';
}

/** Resolve FACTORY_PLAN_MODEL / FACTORY_BUILD_MODEL env overrides, validated
 *  against the registry. Throws a configuration error naming the env var when
 *  it references a model not present in models.json. Empty/whitespace values
 *  are treated as unset. */
export function resolveModelOverrides(registry: ModelRegistry, env: NodeJS.ProcessEnv = process.env): ModelOverrides {
  const resolveVar = (envVar: 'FACTORY_PLAN_MODEL' | 'FACTORY_BUILD_MODEL'): string | undefined => {
    const value = env[envVar]?.trim();
    if (!value) return undefined;
    if (!registry.get(value)) {
      throw new Error(
        `${envVar} is set to '${value}', which is not a model in models.json (known models: ${registry.list().join(', ')})${retiredModelHint(value)}`,
      );
    }
    return value;
  };
  return { plan: resolveVar('FACTORY_PLAN_MODEL'), build: resolveVar('FACTORY_BUILD_MODEL') };
}
