// src/models/index.ts — Model registry: availability checks, cost calculation, tier resolution

import { execSync } from 'node:child_process';
import type { ModelDefinition, ModelTier } from '../types/index.js';
import type { ModelsConfig } from '../config/index.js';

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
    return (inputTokens / 1_000_000) * def.costPerMtokInput +
           (outputTokens / 1_000_000) * def.costPerMtokOutput;
  }

  /** Get all available models for a tier, in priority order */
  getAvailableModelsForTier(tier: string, byok = false, allowExperimental = false, localOnly = false): string[] {
    return this.getModelsInTier(tier).filter(m => {
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
export function resolveModelOverrides(
  registry: ModelRegistry,
  env: NodeJS.ProcessEnv = process.env,
): ModelOverrides {
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
}

export interface ModelDiagnosis {
  model: string;
  provider: string;
  tiers: ModelTier[];
  reachable: boolean;
  experimental: boolean;
  reason: string;
}

/** Probe which registered models are actually reachable on this machine (CLIs on PATH, env keys set). */
export function diagnoseModels(
  registry: ModelRegistry,
  probes: DoctorProbes = {},
  allowExperimental = false,
  localOnly = false,
): ModelDiagnosis[] {
  const commandAvailable = probes.commandAvailable ?? isCommandAvailable;
  const envPresent = probes.envPresent ?? ((key: string) => !!process.env[key]);
  const ollamaModelPresent = probes.ollamaModelPresent;

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
    } else if (def.codex === true && def.provider === 'ollama') {
      if (!commandAvailable('ollama')) {
        reason = 'ollama not found on PATH';
      } else if (ollamaModelPresent && !ollamaModelPresent(registry.getProviderModel(m))) {
        reason = `${registry.getProviderModel(m)} not found in ollama list`;
      } else {
        reachable = true;
        reason = 'ok (ollama native command agent)';
      }
    } else if (def.codex === true) {
      // Deliberately does not check def.envKey here, unlike ModelRegistry.isAvailable():
      // the codex CLI carries its own (OAuth-based) auth, so a missing API key doesn't
      // make the model unreachable for doctor purposes.
      if (!commandAvailable('codex')) {
        reason = 'codex CLI not found on PATH';
      } else {
        reachable = true;
        reason = 'ok (codex CLI)';
      }
    } else if (provider === 'ollama') {
      if (!commandAvailable('ollama')) {
        reason = 'ollama not found on PATH';
      } else if (ollamaModelPresent && !ollamaModelPresent(registry.getProviderModel(m))) {
        reason = `${registry.getProviderModel(m)} not found in ollama list`;
      } else {
        reachable = true;
        reason = 'ok (ollama native)';
      }
    } else if (!commandAvailable('claude')) {
      reason = 'claude CLI not found on PATH';
    } else if (provider === 'anthropic') {
      reachable = true;
      reason = envPresent(def.envKey ?? 'ANTHROPIC_API_KEY')
        ? 'ok (claude CLI)'
        : `ok (claude CLI auth; ${def.envKey ?? 'ANTHROPIC_API_KEY'} not set)`;
    } else if (def.envKey && !envPresent(def.envKey)) {
      reason = `${def.envKey} not set`;
    } else {
      reachable = true;
      reason = 'ok (claude CLI)';
    }

    return { model: m, provider, tiers, reachable, experimental, reason };
  });
}
