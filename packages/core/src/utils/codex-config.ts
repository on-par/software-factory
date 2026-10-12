// src/utils/codex-config.ts — answers "is the codex CLI logged in?" without any inference call.
//
// A leaf module: node built-ins only. `codex login status` reads stored credentials
// (auth.json or the OS keyring) and makes no model request, so it costs no quota (#2418).

import { execFileSync } from 'node:child_process';

export interface CodexLoginEvidenceDeps {
  env?: NodeJS.ProcessEnv;
  /** Runs a command, throws on non-zero exit. Default: execFileSync with stdio 'ignore' and a 10s timeout. */
  exec?: (file: string, args: readonly string[]) => void;
}

const defaultExec = (file: string, args: readonly string[]): void => {
  execFileSync(file, [...args], { stdio: 'ignore', timeout: 10_000 });
};

/** True when the codex CLI has a usable login, found without any inference call (#2418).
 *  Evidence order: CODEX_API_KEY set (non-empty); `codex login status` exits 0 (it reads stored
 *  credentials from auth.json or the keyring and makes no model request). Never throws. */
export function hasCodexLoginEvidence(deps: CodexLoginEvidenceDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  if (env.CODEX_API_KEY?.trim()) return true;
  try {
    exec('codex', ['login', 'status']);
    return true;
  } catch {
    return false;
  }
}
