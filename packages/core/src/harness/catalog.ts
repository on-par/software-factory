export type HarnessProbe =
  | {
      kind: 'command';
      command: string;
      okLabel: string;
      auth: 'env-key' | 'cli';
      selfAuth?: { providers: string[]; defaultEnvKey: string };
    }
  | {
      kind: 'ollama';
      okLabel: string;
    };

export interface HarnessCatalogEntry {
  id: string;
  agentic: boolean;
  genericBuildRoute?: boolean;
  autoLoads?: readonly string[];
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
    autoLoads: ['AGENTS.md'],
    probe: { kind: 'command', command: 'codex', okLabel: 'codex CLI', auth: 'cli' },
  },
  { id: 'ollama-http', agentic: false, probe: { kind: 'ollama', okLabel: 'ollama native' } },
  {
    id: 'opencode',
    agentic: true,
    autoLoads: ['AGENTS.md'],
    probe: { kind: 'command', command: 'opencode', okLabel: 'opencode CLI', auth: 'cli' },
  },
  {
    id: 'pi',
    agentic: true,
    genericBuildRoute: true,
    probe: { kind: 'command', command: 'pi', okLabel: 'pi CLI', auth: 'cli' },
  },
  { id: 'ollama-agentic', agentic: true, probe: { kind: 'ollama', okLabel: 'ollama agentic' } },
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

export const LEGACY_CODEX_OLLAMA_HARNESS = 'ollama-command-agent';

export const RETIRED_HARNESS_ALIASES: Readonly<Record<string, string>> = {
  [LEGACY_CODEX_OLLAMA_HARNESS]: 'ollama-agentic',
};

export function retiredHarnessReplacement(id: string): string | undefined {
  return Object.hasOwn(RETIRED_HARNESS_ALIASES, id) ? RETIRED_HARNESS_ALIASES[id] : undefined;
}

type HarnessInferenceInput = { harness?: string; codex?: boolean; provider: string };

export function retiredHarnessIdOf(def: HarnessInferenceInput | undefined): string | undefined {
  if (!def) return undefined;
  if (def.harness) return retiredHarnessReplacement(def.harness) ? def.harness : undefined;
  return def.codex && def.provider === 'ollama' ? LEGACY_CODEX_OLLAMA_HARNESS : undefined;
}

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

export function builtInHarnessRedeclaredMessage(id: string): string {
  return `Harness '${id}' is built in and cannot be redeclared under harnesses`;
}

export function isAgenticHarness(harnessId: string): boolean {
  return HARNESS_CATALOG[harnessId]?.agentic ?? false;
}

export function harnessAutoLoads(harnessId: string | undefined): readonly string[] {
  return (harnessId ? HARNESS_CATALOG[harnessId]?.autoLoads : undefined) ?? [];
}

export function usesGenericBuildRoute(harnessId: string): boolean {
  return HARNESS_CATALOG[harnessId]?.genericBuildRoute === true;
}

export function harnessCliCommand(harnessId: string | undefined): string | undefined {
  const probe = harnessId ? HARNESS_CATALOG[harnessId]?.probe : undefined;
  return probe?.kind === 'command' ? probe.command : undefined;
}
