// src/config/intermediaries.ts — Approved zero-retention intermediaries for DeepSeek models (ADR-0163)

export interface Intermediary {
  name: string;
  /** providerModel prefix that routes through this intermediary, e.g. 'openrouter/'. */
  prefix: string;
  host: string;
  status: 'approved' | 'pending';
  /** ISO date when approval must be re-checked (OpenCode Go ZDR expiry). */
  reviewBy?: string;
  /** Serves an Anthropic Messages API usable as the claude CLI's ANTHROPIC_BASE_URL (#2906). */
  anthropicCompatible?: boolean;
}

/** Intermediaries DeepSeek models may be routed through (ADR-0163). Azure Foundry is pending verification, so its
 *  prefix and host are placeholders that are never used for acceptance. */
export const APPROVED_INTERMEDIARIES: readonly Intermediary[] = [
  { name: 'OpenRouter', prefix: 'openrouter/', host: 'openrouter.ai', status: 'approved', anthropicCompatible: true },
  { name: 'OpenCode Go', prefix: 'opencode-go/', host: 'opencode.ai', status: 'approved', reviewBy: '2026-10-31' },
  { name: 'Azure Foundry', prefix: 'azure/', host: 'ai.azure.com', status: 'pending' },
];

/** The APPROVED_INTERMEDIARIES entry whose prefix routes `providerModel`, or undefined. Pure. */
export function intermediaryFor(providerModel: string): Intermediary | undefined {
  const pm = providerModel.trim().toLowerCase();
  return APPROVED_INTERMEDIARIES.find((i) => pm.startsWith(i.prefix));
}

/** The approved Anthropic-compatible intermediary an https `endpoint` points at (exact host match), or undefined. Pure. */
export function claudeEndpointIntermediary(endpoint: string): Intermediary | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  return APPROVED_INTERMEDIARIES.find(
    (i) => i.status === 'approved' && i.anthropicCompatible && i.host === url.hostname,
  );
}

/** Throws unless a registry model's `endpoint` (when set) is an approved Anthropic-compatible intermediary and the
 *  model names an envKey (#2906, ADR-0163). */
export function assertApprovedClaudeEndpoint(id: string, def: { endpoint?: string; envKey: string | null }): void {
  if (def.endpoint === undefined) return;
  if (!claudeEndpointIntermediary(def.endpoint)) {
    const allowed = APPROVED_INTERMEDIARIES.filter((i) => i.status === 'approved' && i.anthropicCompatible).map(
      (i) => i.host,
    );
    throw new Error(
      `.factory/config.json: models.registry.${id}.endpoint '${def.endpoint}' is not an approved Anthropic-compatible intermediary (allowed hosts: ${allowed.join(', ')}; https only). DeepSeek and other non-Anthropic models are reached only through approved zero-retention intermediaries (ADR-0163)`,
    );
  }
  if (def.envKey === null) {
    throw new Error(
      `.factory/config.json: models.registry.${id} sets an endpoint but envKey is null; an endpoint needs envKey naming the intermediary's API key variable`,
    );
  }
}

const DEEPSEEK_DOMAIN = 'deepseek.com';
const DEEPSEEK_KEY = 'DEEPSEEK_API_KEY';

function collectStrings(value: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, `${path}.${k}`, out);
  }
  return out;
}

/** The DeepSeek first-party hostname `value` points at (deepseek.com or a dot-bounded subdomain such as
 *  api.deepseek.com), or undefined. Parses `value` as a URL, adding `https://` when it has no scheme, and compares the
 *  hostname exactly, so a lookalike host or a deepseek.com in the path or query is not a match. Pure. */
function deepSeekHost(value: string): string | undefined {
  const raw = value.trim();
  let host: string;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/\.$/, '');
  } catch {
    return undefined;
  }
  return host === DEEPSEEK_DOMAIN || host.endsWith(`.${DEEPSEEK_DOMAIN}`) ? host : undefined;
}

/** Why a registry model reaches DeepSeek's first-party API (native `deepseek/` provider, DEEPSEEK_API_KEY, or the
 *  deepseek.com hosts such as api.deepseek.com), or undefined. A claude-cli `claudeFlag` of `deepseek/...` is legitimate behind an approved
 *  endpoint, so only the host is checked there. Pure (ADR-0163). */
export function directDeepSeekReason(def: {
  providerModel?: string;
  envKey: string | null;
  claudeFlag?: string;
  providerOptions?: Record<string, unknown>;
}): string | undefined {
  if (def.providerModel !== undefined && def.providerModel.trim().toLowerCase().split('/')[0] === 'deepseek') {
    return `providerModel '${def.providerModel}' uses the native deepseek/ provider`;
  }
  if (def.envKey === DEEPSEEK_KEY) return `envKey '${DEEPSEEK_KEY}' is DeepSeek's first-party API key`;
  const fields: Array<[string, string]> = [];
  if (def.claudeFlag !== undefined) fields.push(['claudeFlag', def.claudeFlag]);
  if (def.providerModel !== undefined) fields.push(['providerModel', def.providerModel]);
  collectStrings(def.providerOptions, 'providerOptions', fields);
  for (const [field, value] of fields) {
    const host = deepSeekHost(value);
    if (host !== undefined) return `${field} '${value}' points at ${host}`;
  }
  return undefined;
}

/** Throws when a registry model would reach DeepSeek's first-party API instead of an approved intermediary (ADR-0163). */
export function assertNoDirectDeepSeek(
  id: string,
  def: {
    providerModel?: string;
    envKey: string | null;
    claudeFlag?: string;
    providerOptions?: Record<string, unknown>;
  },
): void {
  const reason = directDeepSeekReason(def);
  if (reason === undefined) return;
  const approved = APPROVED_INTERMEDIARIES.filter((i) => i.status === 'approved')
    .map((i) => `${i.name} (${i.prefix})`)
    .join(', ');
  throw new Error(
    `.factory/config.json: models.registry.${id} reaches DeepSeek's first-party API: ${reason}. DeepSeek models are reached only through approved zero-retention intermediaries (ADR-0163): ${approved}`,
  );
}
