import { z } from 'zod';

import { builtInHarnessRedeclaredMessage, KNOWN_HARNESS_IDS } from '../harness/catalog.js';
import { HarnessDeclarationSchema, type ModelsConfig } from './index.js';

export const RepoHarnessesSchema = z
  .record(z.string(), HarnessDeclarationSchema)
  .optional()
  .describe(
    "Repo-declared agent CLIs: harness id -> declaration (command, prompt, output, agentic, usage, optional errorPatterns and probe). Run through the built-in `command` harness. Reference an id from a models.registry entry's `harness`. Built-in harness ids cannot be redeclared.",
  );

/** Merge a repo's `harnesses` over the packaged declarations (repo wins) and list every valid harness id.
 *  `patch` is empty when the repo declares none, so the packaged `harnesses` value is left untouched.
 *  Throws when a repo id is built in. */
export function resolveRepoHarnesses(
  models: ModelsConfig,
  repoHarnesses: z.infer<typeof RepoHarnessesSchema>,
): { valid: string[]; patch: Pick<ModelsConfig, 'harnesses'> | Record<string, never> } {
  for (const id of Object.keys(repoHarnesses ?? {})) {
    if (KNOWN_HARNESS_IDS.includes(id)) {
      throw new Error(`.factory/config.json: harnesses.${id}: ${builtInHarnessRedeclaredMessage(id)}`);
    }
  }
  const merged = { ...models.harnesses, ...repoHarnesses };
  return { valid: [...KNOWN_HARNESS_IDS, ...Object.keys(merged)], patch: repoHarnesses ? { harnesses: merged } : {} };
}
