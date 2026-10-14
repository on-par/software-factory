import type { ModelRegistry } from '../models/index.js';

/** Narrow a route's candidate models to the harness its `requires` names. */
export function filterModelsByRequires(
  registry: ModelRegistry,
  models: string[],
  requires: string | undefined,
): string[] {
  if (requires === 'codex') return models.filter((model) => registry.isCodexModel(model));
  // build_claude's prompt contract assumes the claude-cli harness (it drives its own commits).
  // Running a codex-cli model there "succeeds" but leaves the worktree with no commits, so the
  // ship phase fails and parks the lane.
  if (requires === 'claude') return models.filter((model) => registry.getHarnessId(model) === 'claude-cli');
  // build_opencode runs through the opencode CLI harness (e.g. deepseek).
  if (requires === 'opencode') return models.filter((model) => registry.getHarnessId(model) === 'opencode');
  // build_command runs a harness the repo declared under `harnesses` (byo); only agentic ones edit files.
  if (requires === 'command') {
    return models.filter((model) => {
      const harness = registry.getHarnessId(model);
      return !!harness && !!registry.getHarnessDeclaration(harness) && registry.isAgenticHarnessId(harness);
    });
  }
  return models;
}
