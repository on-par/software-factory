import { z } from 'zod';
import { loadModelsConfig } from '../config/index.js';
import { RepoFactoryConfigV2Schema, applyRepoConfig, resolveEffectiveModelPins } from '../config/repo.js';
import { ModelRegistry } from '../models/index.js';

/** Only model policy crosses the execution API; no paths, credentials, commands or security settings. */
export const ExecutionConfigSchema = RepoFactoryConfigV2Schema.extend({
  auto_failover: z.object({ enabled: z.boolean() }).strict(),
}).strict();
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

export function validateExecutionConfig(input: unknown): ExecutionConfig {
  const config = ExecutionConfigSchema.parse(input);
  const registry = new ModelRegistry(applyRepoConfig(loadModelsConfig(), config));
  resolveEffectiveModelPins(registry, config, {});
  for (const id of Object.values(config.models?.pins ?? {})) {
    const model = registry.get(id);
    if (model && config.providers?.[model.provider as keyof NonNullable<typeof config.providers>] === false) {
      throw new Error(`Pinned model '${id}' belongs to a disabled provider`);
    }
  }
  return config;
}
