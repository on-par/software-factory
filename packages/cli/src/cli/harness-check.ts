// packages/cli/src/cli/harness-check.ts — `factory harness check <id>`: contract kit against a declared harness (#2875)

import { execFileSync } from 'node:child_process';

import type { ModelsConfig, RepoFactoryConfig } from '@on-par/factory-core';
import { applyRepoConfig, loadModelsConfig, loadRepoConfig, ModelRegistry } from '@on-par/factory-core';
import type { HarnessCheckOptions, HarnessCheckResult } from '@on-par/factory-core/internal';
import { runHarnessCheck } from '@on-par/factory-core/internal';

export interface HarnessCheckCommandDeps {
  repoRoot: string;
  loadModelsConfig: () => ModelsConfig;
  loadRepoConfig: (root: string) => RepoFactoryConfig | null;
  applyRepoConfig: (m: ModelsConfig, r: RepoFactoryConfig | null) => ModelsConfig;
  runHarnessCheck: (opts: HarnessCheckOptions) => Promise<HarnessCheckResult[]>;
  log: (line: string) => void;
}

export function formatHarnessCheckLine(result: HarnessCheckResult): string {
  if (result.ok) return `PASS ${result.name}`;
  return `FAIL ${result.name}: ${result.error ?? 'failed'} | rule: ${result.rule} | fix: ${result.fix}`;
}

/** Returns the process exit code: 0 only when every contract case passes. */
export async function runHarnessCheckCommand(
  id: string,
  opts: { model?: string; injection?: boolean },
  deps: HarnessCheckCommandDeps,
): Promise<number> {
  let merged: ModelsConfig;
  try {
    merged = deps.applyRepoConfig(deps.loadModelsConfig(), deps.loadRepoConfig(deps.repoRoot));
  } catch (err) {
    deps.log(`factory harness check: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const declarations = merged.harnesses ?? {};
  const declaration = declarations[id];
  if (!declaration) {
    deps.log(`no declared harness '${id}' (declared: ${Object.keys(declarations).join(', ') || 'none'})`);
    return 1;
  }

  let model: string | undefined;
  if (opts.model) {
    const def = merged.models[opts.model];
    if (!def) {
      deps.log(`unknown model '${opts.model}'`);
      return 1;
    }
    if (def.harness !== id) {
      deps.log(`model '${opts.model}' does not run on harness '${id}'`);
      return 1;
    }
    model = opts.model;
  } else {
    model = Object.entries(merged.models).find(([, def]) => def.harness === id)?.[0];
    if (!model) {
      deps.log(
        `harness check needs a model on '${id}': add a models.registry entry with harness: ${id}, or pass --model <registry id>`,
      );
      return 1;
    }
  }

  const results = await deps.runHarnessCheck({
    id,
    declaration,
    model,
    registry: new ModelRegistry(merged),
    injection: opts.injection !== false,
  });
  for (const r of results) deps.log(formatHarnessCheckLine(r));
  const passed = results.filter((r) => r.ok).length;
  deps.log(`${passed}/${results.length} cases passed`);
  return results.every((r) => r.ok) ? 0 : 1;
}

/** Commander action: binds the real config loaders and the contract kit, and sets the exit code. */
export async function cmdHarnessCheck(id: string, opts: { model?: string; injection?: boolean }): Promise<void> {
  let repoRoot: string;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  } catch {
    console.error('factory: not inside a git repository');
    process.exitCode = 2;
    return;
  }
  const code = await runHarnessCheckCommand(id, opts, {
    repoRoot,
    loadModelsConfig,
    loadRepoConfig,
    applyRepoConfig,
    runHarnessCheck,
    log: console.log,
  });
  if (code !== 0) process.exitCode = code;
}
