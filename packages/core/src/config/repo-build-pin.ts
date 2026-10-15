// src/config/repo-build-pin.ts — BUILD pin validation, split out of repo.ts (max-lines baseline).

import type { ModelRegistry } from '../models/index.js';

/** BUILD edits files, so a build pin must run on an agentic harness (#2871). */
export function assertAgenticBuildPin(
  registry: ModelRegistry,
  model: string,
  source: 'repo' | 'env' | undefined,
  field: 'build' | 'buildFallback' = 'build',
): void {
  const label = source === 'env' ? 'FACTORY_BUILD_MODEL' : `.factory/config.json: models.pins.${field}`;
  const harnessId = registry.getHarnessId(model) ?? '';
  if (registry.isAgenticHarnessId(harnessId)) return;
  const fix = registry.getHarnessDeclaration(harnessId)
    ? `set agentic: true under harnesses.${harnessId}, or pin a model on claude-cli, codex-cli, opencode or pi`
    : 'pin a model on claude-cli, codex-cli, opencode or pi';
  throw new Error(
    `${label} '${model}' runs on harness '${harnessId}', which is not agentic; BUILD needs an agentic harness (${fix})`,
  );
}
