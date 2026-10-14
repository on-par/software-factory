// src/config/intermediaries.ts — Approved zero-retention intermediaries for DeepSeek models (ADR-0163)

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

/** The APPROVED_INTERMEDIARIES entry whose prefix routes `providerModel`, or undefined. Pure. */
export function intermediaryFor(providerModel: string): Intermediary | undefined {
  const pm = providerModel.trim().toLowerCase();
  return APPROVED_INTERMEDIARIES.find((i) => pm.startsWith(i.prefix));
}
