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

  /** Check if a model is fully available (env key + required binaries) */
  isAvailable(modelId: string): boolean {
    if (!this.isEnvAvailable(modelId)) return false;
    if (this.isCodexModel(modelId) && !isCommandAvailable('codex')) return false;
    return true;
  }

  /** Get the claude -p flag for a model */
  getClaudeFlag(modelId: string): string | undefined {
    return this.get(modelId)?.claudeFlag;
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
  getAvailableModelsForTier(tier: string, byok = false): string[] {
    return this.getModelsInTier(tier).filter(m => {
      if (byok && !this.isEnvAvailable(m)) return false;
      return this.isAvailable(m);
    });
  }

  /** Get the failover config */
  get failover() {
    return this.config.failover;
  }
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