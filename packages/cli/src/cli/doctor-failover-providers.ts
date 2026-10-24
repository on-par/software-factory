// Doctor rows for failover providers that models.providerOrder would refuse (#3335).

import { existsSync } from 'node:fs';

import { applyRepoConfig } from '@on-par/factory-core';
import {
  filterRefusedProviders,
  OPENCODE_GO_DEFAULT_MODEL,
  shellEscape,
  type ProviderOrder,
  type RefusedProvider,
} from '@on-par/factory-core/internal';

import type { DoctorCheck, DoctorRuntime } from './doctor.js';

export const PROVIDER_REFUSAL_SECTION = 'Failover providers';

/** One optional (non-failing) row per refused provider, with how to switch it to a subscription login. */
export function refusedProviderChecks(refused: readonly RefusedProvider[]): DoctorCheck[] {
  return refused.map(({ provider, login, models }): DoctorCheck => {
    const row = { name: `failover provider ${provider}`, ok: false, optional: true, section: PROVIDER_REFUSAL_SECTION };
    if (provider === 'claude') {
      return login === 'api'
        ? {
            ...row,
            detail: 'refused: signed in with ANTHROPIC_API_KEY (metered API) — never run from models.providerOrder',
            fix: 'unset ANTHROPIC_API_KEY and sign in with your Claude Pro/Max subscription',
            next: 'claude /login',
          }
        : {
            ...row,
            detail: 'refused: no Claude subscription login found',
            fix: 'sign in with your Claude Pro/Max subscription',
            next: 'claude /login',
          };
    }
    if (provider === 'codex') {
      return login === 'api'
        ? {
            ...row,
            detail: 'refused: signed in with an OpenAI API key (metered)',
            fix: 'unset OPENAI_API_KEY and CODEX_API_KEY, remove OPENAI_API_KEY from $CODEX_HOME/auth.json (default ~/.codex), then sign in with ChatGPT',
            next: 'codex login',
          }
        : {
            ...row,
            detail: 'refused: no Codex ChatGPT login found',
            fix: 'sign in to Codex with your ChatGPT subscription',
            next: 'codex login',
          };
    }
    if (provider === 'opencode-go') {
      return {
        ...row,
        detail: `refused: ${models.join(', ')} not an opencode-go/ model (OpenCode Zen is metered)`,
        fix: `use an OpenCode Go model such as '${OPENCODE_GO_DEFAULT_MODEL}' in models.providerOrder`,
      };
    }
    return { ...row, detail: 'refused: not a subscription provider', fix: 'remove it from models.providerOrder' };
  });
}

/** Refused-provider rows for the merged provider order. A config problem adds no rows; doctor keeps going. */
export function failoverProviderChecks(rt: DoctorRuntime, repoRoot: string | null): DoctorCheck[] {
  try {
    const base = rt.configLoaders.loadModelsConfig();
    const merged = repoRoot === null ? base : applyRepoConfig(base, rt.configLoaders.loadRepoConfig(repoRoot));
    if (merged.providerOrder === undefined) return [];
    const exec = (file: string, args: readonly string[]): void => {
      rt.shellOps.execSync([file, ...args].map(shellEscape).join(' '), { timeout: 10_000, stdio: 'ignore' });
    };
    const order = merged.providerOrder as ProviderOrder;
    return refusedProviderChecks(
      filterRefusedProviders(order, merged.models, { exec, fileExists: existsSync }).refused,
    );
  } catch {
    return [];
  }
}
