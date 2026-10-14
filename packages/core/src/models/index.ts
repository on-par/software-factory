// src/models/index.ts — Model registry: availability checks, cost calculation, tier resolution

import { execSync } from 'node:child_process';

import { retiredModels } from '@on-par/factory-config';

import { ModelEffortsSchema, supportsEffort } from '../config/effort.js';
import type { HarnessDeclaration, ModelsConfig } from '../config/index.js';
import { HARNESS_CATALOG, harnessCliCommand, isAgenticHarness, KNOWN_HARNESS_IDS } from '../harness/catalog.js';
import type { ModelDefinition, ModelTier } from '../types/index.js';
import { hasClaudeLoginEvidence } from '../utils/claude-config.js';
import { hasCodexLoginEvidence } from '../utils/codex-config.js';
import {
  type LocalAuthAgent,
  type LocalAuthFailure,
  localAuthAgentFor,
  localAuthFailureSinceLogin,
} from '../utils/local-auth-record.js';
import { hasOpencodeLoginEvidence } from '../utils/opencode-config.js';

export class ModelRegistry {
  constructor(private config: ModelsConfig) {
    if (!config.efforts) return;
    const efforts = ModelEffortsSchema.parse(config.efforts);
    for (const [model, setting] of Object.entries(efforts)) {
      if (!Object.hasOwn(config.models, model)) throw new Error(`models.efforts: unknown model '${model}'`);
      for (const effort of typeof setting === 'object' ? Object.values(setting) : [setting]) {
        if (!supportsEffort(this.getHarnessId(model), effort)) {
          throw new Error(`models.efforts: '${effort}' is not supported by ${this.getHarnessId(model)} for '${model}'`);
        }
      }
    }
    this.config = { ...config, efforts };
  }

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

  /** The user declaration for a harness id under the config's `harnesses`, if any. */
  getHarnessDeclaration(harnessId: string): HarnessDeclaration | undefined {
    return this.config.harnesses && Object.hasOwn(this.config.harnesses, harnessId)
      ? this.config.harnesses[harnessId]
      : undefined;
  }

  /** Ids declared under the config's `harnesses`. */
  listDeclaredHarnesses(): string[] {
    return Object.keys(this.config.harnesses ?? {});
  }

  /** True for agentic built-in harness ids and for declared ids whose declaration says `agentic`. */
  isAgenticHarnessId(harnessId: string): boolean {
    return isAgenticHarness(harnessId) || this.getHarnessDeclaration(harnessId)?.agentic === true;
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

  /** Resolve effort for this model and task without changing other phases or failovers. */
  getEffort(modelId: string, task: string) {
    if (!this.config.efforts || !Object.hasOwn(this.config.efforts, modelId)) return undefined;
    const setting = this.config.efforts[modelId];
    if (typeof setting === 'object' && !Object.hasOwn(setting, task)) return undefined;
    return typeof setting === 'object' ? setting[task] : setting;
  }

  /** Get codex flags for a model */
  getCodexFlag(modelId: string): string | undefined {
    return this.get(modelId)?.codexFlag;
  }

  /** Estimate cost for a model given token counts. Null means unpriced (model not registered); 0 means free (#1738). */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number | null {
    const def = this.get(modelId);
    if (!def) return null;
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

/** Suffix for an unknown-model error when the id is a retired packaged model; '' otherwise. */
export function retiredModelHint(id: string): string {
  const retired = Object.hasOwn(retiredModels, id) ? retiredModels[id] : undefined;
  return retired ? `; '${id}' was removed under ${retired.adr}; use '${retired.replacement}'` : '';
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
        `${envVar} is set to '${value}', which is not a model in models.json (known models: ${registry.list().join(', ')})${retiredModelHint(value)}`,
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

/** True unless the harness needs a CLI that is not on PATH. Harnesses with no CLI probe are always present. */
export function isHarnessCliPresent(
  harnessId: string | undefined,
  commandAvailable: (cmd: string) => boolean = isCommandAvailable,
): boolean {
  const cmd = harnessCliCommand(harnessId);
  return cmd === undefined || commandAvailable(cmd);
}

const HARNESS_PROBE_TIMEOUT_MS = 10_000;

/** Run a declared harness probe command. Returns null on exit 0, else a one-line failure detail. */
export function runHarnessProbe(cmd: string): string | null {
  try {
    execSync(cmd, { stdio: 'pipe', shell: '/bin/bash', timeout: HARNESS_PROBE_TIMEOUT_MS });
    return null;
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; code?: string; stderr?: Buffer | string };
    if (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')
      return `timed out after ${HARNESS_PROBE_TIMEOUT_MS / 1000}s`;
    const firstLine = (err.stderr?.toString() ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '');
    return `exit ${err.status ?? '?'}${firstLine ? `: ${firstLine}` : ''}`;
  }
}

export type HarnessProbeStatus = 'available' | 'unavailable' | 'unverified';

export interface DeclaredHarnessProbe {
  harness: string;
  /** The declared probe command; undefined when none is configured. */
  probe?: string;
  status: HarnessProbeStatus;
  /** Failure detail for 'unavailable'; empty otherwise. */
  detail: string;
}

/** Probe every harness declared under the config's `harnesses`, each at most once. */
export function probeDeclaredHarnesses(
  registry: ModelRegistry,
  runProbe: (cmd: string) => string | null = runHarnessProbe,
): DeclaredHarnessProbe[] {
  return registry.listDeclaredHarnesses().map((harness) => {
    const probe = registry.getHarnessDeclaration(harness)?.probe;
    if (!probe) return { harness, status: 'unverified', detail: '' };
    let failure: string | null;
    try {
      failure = runProbe(probe);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    return failure === null
      ? { harness, probe, status: 'available', detail: '' }
      : { harness, probe, status: 'unavailable', detail: failure };
  });
}

export interface DoctorProbes {
  commandAvailable?: (cmd: string) => boolean;
  envPresent?: (key: string) => boolean;
  ollamaModelPresent?: (model: string) => boolean;
  /** Base URL the Ollama-family harnesses will actually hit (OLLAMA_BASE_URL). */
  ollamaBaseUrl?: () => string | undefined;
  /** Non-inference evidence that the claude CLI is logged in (keychain entry / credentials file /
   *  CLAUDE_CODE_OAUTH_TOKEN). Default: hasClaudeLoginEvidence(). Never runs `claude -p`. */
  claudeLoggedIn?: () => boolean;
  /** Non-inference evidence that the codex CLI is logged in (`codex login status` exit 0 /
   *  CODEX_API_KEY). Default: hasCodexLoginEvidence(). Never runs `codex exec`. */
  codexLoggedIn?: () => boolean;
  /** Non-inference evidence that the opencode CLI is logged in (stored credentials in opencode's
   *  auth.json). Default: hasOpencodeLoginEvidence(). Never runs `opencode run`. */
  opencodeLoggedIn?: () => boolean;
  /** The agent's last recorded run-time local_auth failure when no login has happened since
   *  (#2733). Default: localAuthFailureSinceLogin(). Reads local state only. */
  localAuthFailure?: (agent: LocalAuthAgent) => LocalAuthFailure | null;
  /** Runs a declared harness `probe` command; returns null on exit 0, else a failure detail.
   *  Default: runHarnessProbe. */
  harnessProbe?: (cmd: string) => string | null;
}

export interface ModelDiagnosis {
  model: string;
  provider: string;
  tiers: ModelTier[];
  reachable: boolean;
  /** True when the CLI is installed but shows no auth evidence (no login, no API key). Never reachable. */
  unverified?: boolean;
  experimental: boolean;
  reason: string;
}

const UNVERIFIED_PREFIX = 'unverified — no auth evidence: ';

/** Reason shown when an agent's last run hit local_auth and nobody has logged in since (#2733). */
export function localAuthFailureReason(failure: LocalAuthFailure): string {
  return `${failure.agent} failed sign-in (local_auth) on a run at ${failure.at}, with no login since — re-run ${failure.agent} login`;
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
  const claudeLoggedInProbe = probes.claudeLoggedIn ?? (() => hasClaudeLoginEvidence());
  let claudeLoggedInCache: boolean | undefined;
  const claudeLoggedIn = (): boolean => {
    if (claudeLoggedInCache === undefined) {
      try {
        claudeLoggedInCache = claudeLoggedInProbe();
      } catch {
        claudeLoggedInCache = false;
      }
    }
    return claudeLoggedInCache;
  };
  const codexLoggedInProbe = probes.codexLoggedIn ?? (() => hasCodexLoginEvidence());
  let codexLoggedInCache: boolean | undefined;
  const codexLoggedIn = (): boolean => {
    if (codexLoggedInCache === undefined) {
      try {
        codexLoggedInCache = codexLoggedInProbe();
      } catch {
        codexLoggedInCache = false;
      }
    }
    return codexLoggedInCache;
  };
  const opencodeLoggedInProbe = probes.opencodeLoggedIn ?? (() => hasOpencodeLoginEvidence());
  let opencodeLoggedInCache: boolean | undefined;
  const opencodeLoggedIn = (): boolean => {
    if (opencodeLoggedInCache === undefined) {
      try {
        opencodeLoggedInCache = opencodeLoggedInProbe();
      } catch {
        opencodeLoggedInCache = false;
      }
    }
    return opencodeLoggedInCache;
  };

  const localAuthFailureProbe =
    probes.localAuthFailure ?? ((agent: LocalAuthAgent) => localAuthFailureSinceLogin(agent));
  const localAuthFailureCache = new Map<LocalAuthAgent, LocalAuthFailure | null>();
  const localAuthFailure = (agent: LocalAuthAgent): LocalAuthFailure | null => {
    if (!localAuthFailureCache.has(agent)) {
      let failure: LocalAuthFailure | null = null;
      try {
        failure = localAuthFailureProbe(agent);
      } catch {
        failure = null;
      }
      localAuthFailureCache.set(agent, failure);
    }
    return localAuthFailureCache.get(agent) ?? null;
  };

  let declaredProbes: Map<string, DeclaredHarnessProbe> | undefined;
  const declaredProbe = (id: string): DeclaredHarnessProbe | undefined => {
    declaredProbes ??= new Map(
      probeDeclaredHarnesses(registry, probes.harnessProbe ?? runHarnessProbe).map((p) => [p.harness, p]),
    );
    return declaredProbes.get(id);
  };

  return registry.list().map((m) => {
    const def = registry.get(m)!;
    const experimental = registry.isExperimental(m);
    const tiers = registry.getTiers(m);
    const provider = def.provider;

    let reachable = false;
    let unverified = false;
    let reason = '';

    if (experimental && !allowExperimental) {
      reason = 'experimental — set FACTORY_EXPERIMENTAL=1 to enable';
    } else if (localOnly && !registry.isLocalOnlyModel(m)) {
      reason = 'excluded by FACTORY_LOCAL_ONLY=1';
    } else {
      const harnessId = registry.getHarnessId(m);
      const entry = harnessId ? HARNESS_CATALOG[harnessId] : undefined;
      const declared =
        !entry && harnessId && registry.getHarnessDeclaration(harnessId) ? declaredProbe(harnessId) : undefined;
      if (declared) {
        if (declared.status === 'available') {
          reachable = true;
          reason = `ok (harness '${declared.harness}' probe passed)`;
        } else if (declared.status === 'unavailable') {
          reason = `harness '${declared.harness}' probe failed — ${declared.detail}`;
        } else {
          unverified = true;
          reason = `unverified — harness '${declared.harness}' has no probe configured`;
        }
      } else if (!entry) {
        reason = `unknown harness '${harnessId ?? 'none'}' — declare a 'harness' from: ${KNOWN_HARNESS_IDS.join(', ')}`;
      } else if (entry.probe.kind === 'command') {
        const probe = entry.probe;
        const authAgent = localAuthAgentFor(harnessId);
        const authFailure = authAgent ? localAuthFailure(authAgent) : null;
        if (!isHarnessCliPresent(harnessId, commandAvailable)) {
          reason = `${probe.command} CLI not found on PATH`;
        } else if (authAgent && authFailure) {
          reason = localAuthFailureReason(authFailure);
        } else if (probe.auth === 'cli') {
          // CLI carries its own (OAuth-based) auth — a missing API key doesn't block, but the
          // CLI must show login evidence (#2418). For opencode the envKey is an optional override (#2461).
          if (probe.command === 'codex' && !codexLoggedIn()) {
            unverified = true;
            reason = `${UNVERIFIED_PREFIX}${probe.okLabel} installed but not logged in — run \`codex login\` (or set CODEX_API_KEY)`;
          } else if (probe.command === 'opencode' && def.envKey && !envPresent(def.envKey)) {
            // OPENCODE_API_KEY is an optional override; a CLI login substitutes for it (#2461).
            if (opencodeLoggedIn()) {
              reachable = true;
              reason = `ok (${probe.okLabel} auth; ${def.envKey} not set)`;
            } else {
              unverified = true;
              reason = `${UNVERIFIED_PREFIX}${probe.okLabel} installed but not logged in and ${def.envKey} not set — run \`opencode auth login\` or export ${def.envKey}`;
            }
          } else {
            reachable = true;
            reason = `ok (${probe.okLabel})`;
          }
        } else if (probe.selfAuth?.providers.includes(def.provider)) {
          const key = def.envKey ?? probe.selfAuth.defaultEnvKey;
          if (envPresent(key)) {
            reachable = true;
            reason = `ok (${probe.okLabel})`;
          } else if (claudeLoggedIn()) {
            reachable = true;
            reason = `ok (${probe.okLabel} auth; ${key} not set)`;
          } else {
            unverified = true;
            reason = `${UNVERIFIED_PREFIX}${probe.okLabel} installed but not logged in and ${key} not set — run \`claude /login\` or export ${key} (on macOS, also check the login keychain is readable from this context)`;
          }
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

    return { model: m, provider, tiers, reachable, unverified, experimental, reason };
  });
}
