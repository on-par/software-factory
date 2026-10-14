// src/config/intermediaries.ts — Approved zero-retention intermediaries for DeepSeek models (ADR-0163)
//
// DeepSeek models may only be reached through an approved intermediary, never through DeepSeek's
// first-party API. `directDeepSeekReason` detects model definitions that would bypass that policy.

import type { ModelsConfig } from './index.js';

type ModelDef = ModelsConfig['models'][string];

export interface Intermediary {
  name: string;
  /** providerModel prefix that routes through this intermediary, e.g. 'openrouter/'. */
  prefix: string;
  host: string;
  status: 'approved' | 'pending';
  /** ISO date when approval must be re-checked (OpenCode Go ZDR expiry). */
  reviewBy?: string;
}

/** Intermediaries DeepSeek models may be routed through (ADR-0163). Azure Foundry is pending verification, so its
 *  prefix and host are placeholders that are never used for acceptance. */
export const APPROVED_INTERMEDIARIES: readonly Intermediary[] = [
  { name: 'OpenRouter', prefix: 'openrouter/', host: 'openrouter.ai', status: 'approved' },
  { name: 'OpenCode Go', prefix: 'opencode-go/', host: 'opencode.ai', status: 'approved', reviewBy: '2026-10-31' },
  { name: 'Azure Foundry', prefix: 'azure/', host: 'ai.azure.com', status: 'pending' },
];

const DEEPSEEK_HOST = 'api.deepseek.com';
const DEEPSEEK_ENV_KEY = 'DEEPSEEK_API_KEY';

export function approvedIntermediaryNames(): string[] {
  return APPROVED_INTERMEDIARIES.filter((i) => i.status === 'approved').map((i) => i.name);
}

/** Yield `[dottedPath, value]` for every string nested in `value` (objects and arrays; other types ignored). */
function* walkStrings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* walkStrings(item, `${path}.${i}`);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* walkStrings(item, `${path}.${key}`);
  }
}

/** Why `def` reaches DeepSeek's first-party API, or null when it does not. Pure. */
export function directDeepSeekReason(
  def: Pick<ModelDef, 'providerModel' | 'envKey' | 'claudeFlag' | 'providerOptions'>,
): string | null {
  if (def.providerModel !== undefined && def.providerModel.split('/')[0]!.trim().toLowerCase() === 'deepseek') {
    return `providerModel '${def.providerModel}' uses the native deepseek/ provider`;
  }
  if (def.envKey?.toUpperCase() === DEEPSEEK_ENV_KEY) {
    return `envKey ${DEEPSEEK_ENV_KEY} is DeepSeek's first-party API key`;
  }
  const candidates: Array<[string, string]> = [];
  if (def.claudeFlag !== undefined) candidates.push(['claudeFlag', def.claudeFlag]);
  if (def.providerModel !== undefined) candidates.push(['providerModel', def.providerModel]);
  if (def.providerOptions !== undefined) candidates.push(...walkStrings(def.providerOptions, 'providerOptions'));
  for (const [field, text] of candidates) {
    if (text.toLowerCase().includes(DEEPSEEK_HOST)) return `${field} points at ${DEEPSEEK_HOST}`;
  }
  return null;
}
