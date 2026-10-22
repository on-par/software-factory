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
  /** Built-in agentic harness with no dedicated build route: BUILD rides the generic commit-only
   *  `command` route (#2909). */
  genericBuildRoute?: boolean;
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
  {
    id: 'pi',
    agentic: true,
    genericBuildRoute: true,
    probe: { kind: 'command', command: 'pi', okLabel: 'pi CLI', auth: 'cli' },
  },
  { id: 'ollama-agentic', agentic: true, probe: { kind: 'ollama', okLabel: 'ollama agentic' } },
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

/** Harness id the pre-#187 codex+ollama inference used; now only a retired alias (#3445, ADR-0003). */
export const LEGACY_CODEX_OLLAMA_HARNESS = 'ollama-command-agent';

/** Retired built-in harness ids and the contract-verified harness each now runs on. */
export const RETIRED_HARNESS_ALIASES: Readonly<Record<string, string>> = {
  [LEGACY_CODEX_OLLAMA_HARNESS]: 'ollama-agentic',
};

export function retiredHarnessReplacement(id: string): string | undefined {
  return Object.hasOwn(RETIRED_HARNESS_ALIASES, id) ? RETIRED_HARNESS_ALIASES[id] : undefined;
}

type HarnessInferenceInput = { harness?: string; codex?: boolean; provider: string };

/** The retired id a model came through: a declared alias, or the legacy codex+ollama inference. */
export function retiredHarnessIdOf(def: HarnessInferenceInput | undefined): string | undefined {
  if (!def) return undefined;
  if (def.harness) return retiredHarnessReplacement(def.harness) ? def.harness : undefined;
  return def.codex && def.provider === 'ollama' ? LEGACY_CODEX_OLLAMA_HARNESS : undefined;
}

/** Harness id for a model: the declared `harness`, else inferred from legacy provider/codex flags
 *  (pre-#187 dispatch behavior). Retired aliases resolve to their replacement. */
export function inferHarnessId(def: HarnessInferenceInput | undefined): string | undefined {
  if (!def) return undefined;
  const retired = retiredHarnessIdOf(def);
  if (retired) return retiredHarnessReplacement(retired) ?? retired;
  if (def.harness) return def.harness;
  if (def.codex) return 'codex-cli';
  return def.provider === 'ollama' ? 'ollama-http' : 'claude-cli';
}

export function retiredHarnessNotice(model: string, retiredId: string): string {
  const replacement = retiredHarnessReplacement(retiredId) ?? retiredId;
  return `Model '${model}' resolves to the retired '${retiredId}' harness; running it on '${replacement}' instead — set "harness": "${replacement}" in its config`;
}

/** Shared by the models-config and repo-config checks so the two cannot drift. */
export function builtInHarnessRedeclaredMessage(id: string): string {
  return `Harness '${id}' is built in and cannot be redeclared under harnesses`;
}

export function isAgenticHarness(harnessId: string): boolean {
  return HARNESS_CATALOG[harnessId]?.agentic ?? false;
}

/** True for a built-in harness whose BUILD runs through the generic `command` route (#2909). */
export function usesGenericBuildRoute(harnessId: string): boolean {
  return HARNESS_CATALOG[harnessId]?.genericBuildRoute === true;
}

/** CLI a catalog harness needs on PATH, or undefined when it has none to check
 *  (Ollama harnesses, declared harnesses, unknown ids). Shared by doctor and the router (#2629). */
export function harnessCliCommand(harnessId: string | undefined): string | undefined {
  const probe = harnessId ? HARNESS_CATALOG[harnessId]?.probe : undefined;
  return probe?.kind === 'command' ? probe.command : undefined;
}
