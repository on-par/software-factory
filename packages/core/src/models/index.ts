// src/models/index.ts — Model registry: availability checks, cost calculation, tier resolution

import { execSync } from 'node:child_process';
import type { ModelDefinition, ModelTier } from '../types/index.js';
import type { ModelsConfig } from '../config/index.js';
import { HARNESS_CATALOG, KNOWN_HARNESS_IDS } from '../harness/catalog.js';

export class ModelRegistry {
  constructor(private config: ModelsConfig) {}

  /** List all model IDs */
  list(): string[] {
    return Object.keys(this.config.models);
  }

  /** Get a model definition by ID */
  get(modelId: string): ModelDefinition | undefined {
    return this.config.models[modelId];
  }

  /** Get the tier(s) for a model */
  getTiers(modelId: string): ModelTier[] {
    const def = this.get(modelId);
    if (!def) return [];
    return Array.isArray(def.tier) ? def.tier : [def.tier as ModelTier];
  }

  /** Get all models in a tier, in priority order */
  getModelsInTier(tier: string): string[] {
    return this.config.tiers[tier] ?? [];
  }

  /** Check if a model's env key is present */
  isEnvAvailable(modelId: string): boolean {
    const def = this.get(modelId);
    if (!def) return false;
    if (!def.envKey) return true; // null = local/free (Ollama)
    return !!process.env[def.envKey];
  }

  /** Check if Codex CLI is available for a model */
  isCodexModel(modelId: string): boolean {
    const def = this.get(modelId);
    return !!def?.codex;
  }

  /** Harness id for a model: the config-declared `harness`, else inferred from
   *  legacy provider/codex flags (pre-#187 dispatch behavior). */
  getHarnessId(modelId: string): string | undefined {
    const def = this.get(modelId);
    if (!def) return undefined;
    if (def.harness) return def.harness;
    if (def.codex && def.provider === 'ollama') return 'ollama-command-agent';
    if (def.codex) return 'codex-cli';
    if (def.provider === 'ollama') return 'ollama-http';
    return 'claude-cli';
  }

  /** Check if a model is speculative/unproven (excluded from routing unless opted in) */
  isExperimental(modelId: string): boolean {
    return !!this.get(modelId)?.experimental;
  }

  /** Check if a model is safe for local-only routing. */
  isLocalOnlyModel(modelId: string): boolean {
    const def = this.get(modelId);
    if (!def) return false;
    const nativeModel = def.providerModel ?? modelId;
    return def.provider === 'ollama' && !nativeModel.includes(':cloud') && !modelId.includes(':cloud');
  }

  /** Check if a model is routable from static config/env. Machine probes live in diagnoseModels(). */
  isAvailable(modelId: string): boolean {
    const def = this.get(modelId);
    if (!def) return false;
    if (!this.isEnvAvailable(modelId)) return false;
    return true;
  }

  /** Get the claude -p flag for a model */
  getClaudeFlag(modelId: string): string | undefined {
    return this.get(modelId)?.claudeFlag;
  }

  /** Get provider-native model id */
  getProviderModel(modelId: string): string {
    return this.get(modelId)?.providerModel ?? modelId;
  }

  /** Get provider-native options */
  getProviderOptions(modelId: string): Record<string, unknown> | undefined {
    return this.get(modelId)?.providerOptions;
  }

  /** Get codex flags for a model */
  getCodexFlag(modelId: string): string | undefined {
    return this.get(modelId)?.codexFlag;
  }

  /** Estimate cost for a model given token counts */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const def = this.get(modelId);
    if (!def) return 0;
    return (inputTokens / 1_000_000) * def.costPerMtokInput + (outputTokens / 1_000_000) * def.costPerMtokOutput;
  }

  /** Get all available models for a tier, in priority order */
  getAvailableModelsForTier(tier: string, byok = false, allowExperimental = false, localOnly = false): string[] {
    return this.getModelsInTier(tier).filter((m) => {
      if (!allowExperimental && this.isExperimental(m)) return false;
      if (localOnly && !this.isLocalOnlyModel(m)) return false;
      if (byok && !this.isEnvAvailable(m)) return false;
      return this.isAvailable(m);
    });
  }

  /** Get the failover config */
  get failover() {
    return this.config.failover;
  }
}

export interface ModelOverrides {
  plan?: string;
  build?: string;
}

/** Resolve FACTORY_PLAN_MODEL / FACTORY_BUILD_MODEL env overrides, validated
 *  against the registry. Throws a configuration error naming the env var when
 *  it references a model not present in models.json. Empty/whitespace values
 *  are treated as unset. */
export function resolveModelOverrides(registry: ModelRegistry, env: NodeJS.ProcessEnv = process.env): ModelOverrides {
  const resolveVar = (envVar: 'FACTORY_PLAN_MODEL' | 'FACTORY_BUILD_MODEL'): string | undefined => {
    const value = env[envVar]?.trim();
    if (!value) return undefined;
    if (!registry.get(value)) {
      throw new Error(
        `${envVar} is set to '${value}', which is not a model in models.json (known models: ${registry.list().join(', ')})`,
      );
    }
    return value;
  };
  return { plan: resolveVar('FACTORY_PLAN_MODEL'), build: resolveVar('FACTORY_BUILD_MODEL') };
}

/** Check if a command is available on PATH */
export function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd} 2>/dev/null`, { stdio: 'pipe', shell: '/bin/bash' });
    return true;
  } catch {
    return false;
  }
}

export interface DoctorProbes {
  commandAvailable?: (cmd: string) => boolean;
  envPresent?: (key: string) => boolean;
  ollamaModelPresent?: (model: string) => boolean;
  /** Base URL the Ollama-family harnesses will actually hit (OLLAMA_BASE_URL). */
  ollamaBaseUrl?: () => string | undefined;
}

export interface ModelDiagnosis {
  model: string;
  provider: string;
  tiers: ModelTier[];
  reachable: boolean;
  experimental: boolean;
  reason: string;
}

/** True when OLLAMA_BASE_URL points at a non-loopback host, i.e. the local
 *  `ollama` CLI and `ollama list` are the wrong probes. Unparseable URLs fall
 *  back to local probing. */
function isRemoteOllamaBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return !['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host);
  } catch {
    return false;
  }
}

/** Probe which registered models are actually reachable on this machine (CLIs on PATH, env keys set).
 *  Probe selection is keyed solely on the model's declared/inferred harness id
 *  (registry.getHarnessId), with probe metadata sourced from the harness catalog. */
export function diagnoseModels(
  registry: ModelRegistry,
  probes: DoctorProbes = {},
  allowExperimental = false,
  localOnly = false,
): ModelDiagnosis[] {
  const commandAvailable = probes.commandAvailable ?? isCommandAvailable;
  const envPresent = probes.envPresent ?? ((key: string) => !!process.env[key]);
  const ollamaModelPresent = probes.ollamaModelPresent;
  const ollamaBaseUrl = probes.ollamaBaseUrl ?? (() => process.env.OLLAMA_BASE_URL);

  return registry.list().map((m) => {
    const def = registry.get(m)!;
    const experimental = registry.isExperimental(m);
    const tiers = registry.getTiers(m);
    const provider = def.provider;

    let reachable = false;
    let reason = '';

    if (experimental && !allowExperimental) {
      reason = 'experimental — set FACTORY_EXPERIMENTAL=1 to enable';
    } else if (localOnly && !registry.isLocalOnlyModel(m)) {
      reason = 'excluded by FACTORY_LOCAL_ONLY=1';
    } else {
      const harnessId = registry.getHarnessId(m);
      const entry = harnessId ? HARNESS_CATALOG[harnessId] : undefined;
      if (!entry) {
        reason = `unknown harness '${harnessId ?? 'none'}' — declare a 'harness' from: ${KNOWN_HARNESS_IDS.join(', ')}`;
      } else if (entry.probe.kind === 'command') {
        const probe = entry.probe;
        if (!commandAvailable(probe.command)) {
          reason = `${probe.command} CLI not found on PATH`;
        } else if (probe.auth === 'cli') {
          // CLI carries its own (OAuth-based) auth — a missing API key doesn't make
          // the model unreachable for doctor purposes (preserves the old codex note).
          reachable = true;
          reason = `ok (${probe.okLabel})`;
        } else if (probe.selfAuth?.providers.includes(def.provider)) {
          const key = def.envKey ?? probe.selfAuth.defaultEnvKey;
          reachable = true;
          reason = envPresent(key) ? `ok (${probe.okLabel})` : `ok (${probe.okLabel} auth; ${key} not set)`;
        } else if (def.envKey && !envPresent(def.envKey)) {
          reason = `${def.envKey} not set`;
        } else {
          reachable = true;
          reason = `ok (${probe.okLabel})`;
        }
      } else {
        // kind === 'ollama' — HTTP harnesses talk to OLLAMA_BASE_URL; only probe the
        // local CLI when the daemon is (implicitly) local.
        const baseUrl = ollamaBaseUrl();
        if (isRemoteOllamaBaseUrl(baseUrl)) {
          reachable = true;
          reason = `ok (${entry.probe.okLabel} via ${baseUrl!.trim()})`;
        } else if (!commandAvailable('ollama')) {
          reason = 'ollama not found on PATH';
        } else if (ollamaModelPresent && !ollamaModelPresent(registry.getProviderModel(m))) {
          reason = `${registry.getProviderModel(m)} not found in ollama list`;
        } else {
          reachable = true;
          reason = `ok (${entry.probe.okLabel})`;
        }
      }
    }

    return { model: m, provider, tiers, reachable, experimental, reason };
  });
}
