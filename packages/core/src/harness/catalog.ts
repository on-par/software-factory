// src/harness/catalog.ts — static metadata for every dispatchable harness id.
// Kept import-free so config validation can depend on it without cycles.

export type HarnessProbe =
  | {
      kind: 'command';
      /** CLI that must be on PATH. */
      command: string;
      /** Human label used in doctor reasons, e.g. 'claude CLI'. */
      okLabel: string;
      /** 'cli' = the harness CLI carries its own auth; a missing envKey never blocks, but the CLI must
       *  show login evidence (codex: `codex login status`; opencode: stored credentials in auth.json). */
      auth: 'env-key' | 'cli';
      /** Providers whose CLI login substitutes for the env key (reachable when the CLI shows login evidence). */
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
    probe: { kind: 'command', command: 'opencode', okLabel: 'opencode CLI', auth: 'cli' },
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
  // Generic adapter that user-declared `harnesses:` ids dispatch to. Declared ids are probed
  // through their own `probe` by probeDeclaredHarnesses; this entry is used only when a model
  // names `command` directly.
  {
    id: 'command',
    agentic: true,
    probe: { kind: 'command', command: 'sh', okLabel: 'command harness', auth: 'cli' },
  },
];

export const HARNESS_CATALOG: Record<string, HarnessCatalogEntry> = Object.fromEntries(
  CATALOG_ENTRIES.map((entry) => [entry.id, entry]),
);

export const KNOWN_HARNESS_IDS = Object.keys(HARNESS_CATALOG);

export function isAgenticHarness(harnessId: string): boolean {
  return HARNESS_CATALOG[harnessId]?.agentic === true;
}

/** CLI a catalog harness needs on PATH, or undefined when it has none to check
 *  (Ollama harnesses, declared harnesses, unknown ids). Shared by doctor and the router (#2629). */
export function harnessCliCommand(harnessId: string | undefined): string | undefined {
  const probe = harnessId ? HARNESS_CATALOG[harnessId]?.probe : undefined;
  return probe?.kind === 'command' ? probe.command : undefined;
}
