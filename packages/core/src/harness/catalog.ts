// src/harness/catalog.ts — static metadata for every dispatchable harness id.
// Kept import-free so config validation can depend on it without cycles.

export type HarnessProbe =
  | {
      kind: 'command';
      /** CLI that must be on PATH. */
      command: string;
      /** Human label used in doctor reasons, e.g. 'claude CLI'. */
      okLabel: string;
      /** 'cli' = the harness CLI carries its own auth; a missing envKey never blocks. */
      auth: 'env-key' | 'cli';
      /** Providers whose CLI login substitutes for the env key (reachable with a soft note). */
      selfAuth?: { providers: string[]; defaultEnvKey: string };
    }
  | {
      kind: 'ollama';
      /** Human label used in doctor reasons, e.g. 'ollama native'. */
      okLabel: string;
    };

export interface HarnessCatalogEntry {
  id: string;
  /** True when the harness can edit files in the worktree (build routes require this). */
  agentic: boolean;
  /** How doctor probes reachability for this harness. */
  probe: HarnessProbe;
}

const CATALOG_ENTRIES: HarnessCatalogEntry[] = [
  {
    id: 'claude-cli',
    agentic: true,
    probe: {
      kind: 'command',
      command: 'claude',
      okLabel: 'claude CLI',
      auth: 'env-key',
      selfAuth: { providers: ['anthropic'], defaultEnvKey: 'ANTHROPIC_API_KEY' },
    },
  },
  {
    id: 'codex-cli',
    agentic: true,
    probe: { kind: 'command', command: 'codex', okLabel: 'codex CLI', auth: 'cli' },
  },
  { id: 'ollama-http', agentic: false, probe: { kind: 'ollama', okLabel: 'ollama native' } },
  {
    id: 'opencode',
    agentic: true,
    probe: { kind: 'command', command: 'opencode', okLabel: 'opencode CLI', auth: 'env-key' },
  },
  { id: 'ollama-agentic', agentic: true, probe: { kind: 'ollama', okLabel: 'ollama agentic' } },
  // Local command-loop worker (runOllamaCommandAgent). Not yet extracted into a
  // contract-verified CodingHarness (out of scope here); dispatched via an
  // internal adapter in CliModelExecutor.
  {
    id: 'ollama-command-agent',
    agentic: true,
    probe: { kind: 'ollama', okLabel: 'ollama native command agent' },
  },
];

export const HARNESS_CATALOG: Record<string, HarnessCatalogEntry> = Object.fromEntries(
  CATALOG_ENTRIES.map(entry => [entry.id, entry]),
);

export const KNOWN_HARNESS_IDS = Object.keys(HARNESS_CATALOG);

export function isAgenticHarness(harnessId: string): boolean {
  return HARNESS_CATALOG[harnessId]?.agentic === true;
}
