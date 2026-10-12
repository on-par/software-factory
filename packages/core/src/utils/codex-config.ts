// src/utils/codex-config.ts — answers "is the codex CLI logged in?" without any inference call.
//
// A leaf module: node built-ins only. `codex login status` reads stored credentials
// (auth.json or the OS keyring) and makes no model request, so it costs no quota (#2418).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

export interface CodexLoginEvidenceDeps {
  env?: NodeJS.ProcessEnv;
  /** Runs a command, throws on non-zero exit. Default: execFileSync with stdio 'ignore' and a 10s timeout. */
  exec?: (file: string, args: readonly string[]) => void;
  /** Home directory. Default: os.homedir(). */
  homedir?: () => string;
  /** Reads a file as utf8, throws when missing. Default: readFileSync(path, 'utf8'). */
  readFile?: (path: string) => string;
  /** Clock in ms. Default: Date.now. */
  now?: () => number;
}

/** Margin so a token about to lapse mid-run already counts as expired. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** True when codex is signed in with ChatGPT and the stored access token has expired (#2509).
 *  The next codex call must then refresh, and a refresh token that was already used or revoked
 *  fails with 401, so `codex login status` alone cannot vouch for the session. This only reads
 *  `$CODEX_HOME/auth.json` (default ~/.codex) and decodes the token's `exp` claim locally: no
 *  network call and no refresh, so it never rotates the refresh token. Never throws; false when
 *  there is no ChatGPT session file to judge (API key login, keyring storage, unreadable file). */
export function codexChatgptSessionExpired(deps: CodexLoginEvidenceDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? osHomedir;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const now = deps.now ?? Date.now;
  try {
    const dir = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    const auth = JSON.parse(readFile(join(dir, 'auth.json'))) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { access_token?: unknown } | null;
    };
    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) return false;
    const token = auth.tokens?.access_token;
    if (typeof token !== 'string') return false;
    const payload = token.split('.')[1];
    if (!payload) return false;
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof exp !== 'number') return false;
    return exp * 1000 <= now() + EXPIRY_SKEW_MS;
  } catch {
    return false;
  }
}

const defaultExec = (file: string, args: readonly string[]): void => {
  execFileSync(file, [...args], { stdio: 'ignore', timeout: 10_000 });
};

/** True when the codex CLI has a usable login, found without any inference call (#2418).
 *  Evidence order: CODEX_API_KEY set (non-empty); `codex login status` exits 0 (it reads stored
 *  credentials from auth.json or the keyring and makes no model request), and a ChatGPT session
 *  whose access token has not expired (#2509). Never throws. */
export function hasCodexLoginEvidence(deps: CodexLoginEvidenceDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  if (env.CODEX_API_KEY?.trim()) return true;
  try {
    exec('codex', ['login', 'status']);
    return !codexChatgptSessionExpired(deps);
  } catch {
    return false;
  }
}
