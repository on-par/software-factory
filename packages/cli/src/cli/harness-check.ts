// packages/cli/src/cli/harness-check.ts — `factory harness check <id>` (#2875).

import { ModelRegistry, type ModelsConfig, type RepoFactoryConfig } from '@on-par/factory-core';
import { type HarnessCheckResult, runHarnessCheck } from '@on-par/factory-core/internal';

type HarnessDeclaration = NonNullable<ModelsConfig['harnesses']>[string];

export interface HarnessCheckCommandDeps {
  repoRoot: string;
  loadModelsConfig: () => ModelsConfig;
  loadRepoConfig: (repoRoot: string) => RepoFactoryConfig | null;
  applyRepoConfig: (modelsConfig: ModelsConfig, repoConfig: RepoFactoryConfig | null) => ModelsConfig;
  /** Injectable seams; default to the real core implementations. */
  runHarnessCheck?: typeof runHarnessCheck;
  registryClass?: typeof ModelRegistry;
}

export function resolveHarnessCheckTarget(
  id: string,
  modelsConfig: ModelsConfig,
  repoConfig: RepoFactoryConfig | null,
  model?: string,
): { declaration: HarnessDeclaration; model: string } | { error: string } {
  const harnesses = modelsConfig.harnesses ?? {};
  const declaration = harnesses[id];
  if (!declaration) {
    const declared = Object.keys(harnesses);
    return { error: `no declared harness '${id}' (declared: ${declared.length > 0 ? declared.join(', ') : 'none'})` };
  }
  if (model !== undefined) {
    const def = modelsConfig.models[model];
    if (!def) return { error: `unknown model '${model}' (see \`factory models\` for the registry)` };
    if (def.harness !== id) {
      return { error: `model '${model}' runs on harness '${def.harness ?? 'none'}', not '${id}'` };
    }
    return { declaration, model };
  }
  const repoModels = repoConfig?.models?.registry ?? {};
  const found =
    Object.keys(repoModels).find((m) => repoModels[m].harness === id) ??
    Object.keys(modelsConfig.models).find((m) => modelsConfig.models[m].harness === id);
  if (!found) {
    return {
      error: `harness check needs a model on '${id}': add a models.registry entry with harness: ${id}, or pass --model <registry id>`,
    };
  }
  return { declaration, model: found };
}

export function formatHarnessCheckResults(results: HarnessCheckResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    if (r.ok) {
      lines.push(`PASS ${r.name}`);
    } else {
      lines.push(`FAIL ${r.name}: ${r.error ?? 'failed'}`, `    rule: ${r.rule}`, `    fix: ${r.fix}`);
    }
  }
  const passed = results.filter((r) => r.ok).length;
  lines.push(`${passed} passed, ${results.length - passed} failed`);
  return lines.join('\n');
}

export async function runHarnessCheckCommand(
  id: string,
  opts: { model?: string },
  deps: HarnessCheckCommandDeps,
): Promise<{ output: string; exitCode: number }> {
  const repoConfig = deps.loadRepoConfig(deps.repoRoot);
  const modelsConfig = deps.applyRepoConfig(deps.loadModelsConfig(), repoConfig);
  const target = resolveHarnessCheckTarget(id, modelsConfig, repoConfig, opts.model);
  if ('error' in target) return { output: target.error, exitCode: 1 };
  const results = await (deps.runHarnessCheck ?? runHarnessCheck)({
    id,
    declaration: target.declaration,
    model: target.model,
    registry: new (deps.registryClass ?? ModelRegistry)(modelsConfig),
  });
  return { output: formatHarnessCheckResults(results), exitCode: results.every((r) => r.ok) ? 0 : 1 };
}
