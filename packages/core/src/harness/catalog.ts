// src/harness/catalog.ts — static metadata for every dispatchable harness id.
// Kept import-free so config validation can depend on it without cycles.

export interface HarnessCatalogEntry {
  id: string;
  /** True when the harness can edit files in the worktree (build routes require this). */
  agentic: boolean;
}

export const HARNESS_CATALOG: Record<string, HarnessCatalogEntry> = {
  'claude-cli': { id: 'claude-cli', agentic: true },
  'codex-cli': { id: 'codex-cli', agentic: true },
  'ollama-http': { id: 'ollama-http', agentic: false },
  // Local command-loop worker (runOllamaCommandAgent). Not yet extracted into a
  // contract-verified CodingHarness (out of scope here); dispatched via an
  // internal adapter in CliModelExecutor.
  'ollama-command-agent': { id: 'ollama-command-agent', agentic: true },
};

export const KNOWN_HARNESS_IDS = Object.keys(HARNESS_CATALOG);

export function isAgenticHarness(harnessId: string): boolean {
  return HARNESS_CATALOG[harnessId]?.agentic === true;
}
