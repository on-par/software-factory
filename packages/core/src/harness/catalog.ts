// src/harness/catalog.ts — static metadata for every dispatchable harness id.
// Kept import-free so config validation can depend on it without cycles.

export interface HarnessCatalogEntry {
  id: string;
  /** True when the harness can edit files in the worktree (build routes require this). */
  agentic: boolean;
}

const CATALOG_ENTRIES: HarnessCatalogEntry[] = [
  { id: 'claude-cli', agentic: true },
  { id: 'codex-cli', agentic: true },
  { id: 'ollama-http', agentic: false },
  { id: 'opencode', agentic: true },
  { id: 'ollama-agentic', agentic: true },
  // Local command-loop worker (runOllamaCommandAgent). Not yet extracted into a
  // contract-verified CodingHarness (out of scope here); dispatched via an
  // internal adapter in CliModelExecutor.
  { id: 'ollama-command-agent', agentic: true },
];

export const HARNESS_CATALOG: Record<string, HarnessCatalogEntry> = Object.fromEntries(
  CATALOG_ENTRIES.map(entry => [entry.id, entry]),
);

export const KNOWN_HARNESS_IDS = Object.keys(HARNESS_CATALOG);

export function isAgenticHarness(harnessId: string): boolean {
  return HARNESS_CATALOG[harnessId]?.agentic === true;
}
