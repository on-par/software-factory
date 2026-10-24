import { z } from 'zod';

import { builtInHarnessRedeclaredMessage, KNOWN_HARNESS_IDS, retiredHarnessReplacement } from '../harness/catalog.js';
import { DEFAULT_REPO_CONFIG_LABEL } from './repo-config-label.js';
import { HarnessDeclarationSchema, type ModelsConfig } from './index.js';

export const RepoHarnessesSchema = z
  .record(z.string(), HarnessDeclarationSchema)
  .optional()
  .describe(
    "Repo-declared agent CLIs: harness id -> declaration (command, prompt, output, agentic, usage, optional errorPatterns and probe). Run through the built-in `command` harness. Reference an id from a models.registry entry's `harness`. Built-in harness ids cannot be redeclared.",
  );

/** Throws when a registry model declares a harness that is neither built in nor declared under `harnesses`. */
export function assertRegistryHarness(
  id: string,
  harness: string | undefined,
  valid: string[],
  configLabel = DEFAULT_REPO_CONFIG_LABEL,
): void {
  if (harness !== undefined && !valid.includes(harness) && retiredHarnessReplacement(harness) === undefined) {
    throw new Error(
      `${configLabel}: models.registry.${id} declares unknown harness '${harness}' (valid harnesses: ${valid.join(', ')})`,
    );
  }
}

/** Merge a repo's `harnesses` over the packaged declarations (repo wins) and list every valid harness id.
 *  `patch` is empty when the repo declares none, so the packaged `harnesses` value is left untouched.
 *  Throws when a repo id is built in. */
export function resolveRepoHarnesses(
  models: ModelsConfig,
  repoHarnesses: z.infer<typeof RepoHarnessesSchema>,
  configLabel = DEFAULT_REPO_CONFIG_LABEL,
): { valid: string[]; patch: Pick<ModelsConfig, 'harnesses'> | Record<string, never> } {
  for (const id of Object.keys(repoHarnesses ?? {})) {
    if (KNOWN_HARNESS_IDS.includes(id) || retiredHarnessReplacement(id) !== undefined) {
      throw new Error(`${configLabel}: harnesses.${id}: ${builtInHarnessRedeclaredMessage(id)}`);
    }
  }
  const merged = { ...models.harnesses, ...repoHarnesses };
  return { valid: [...KNOWN_HARNESS_IDS, ...Object.keys(merged)], patch: repoHarnesses ? { harnesses: merged } : {} };
}
