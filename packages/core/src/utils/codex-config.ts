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

/** State of a stored Codex ChatGPT session, judged from `$CODEX_HOME/auth.json` alone (#2509).
 *  - `ok`: the access token is still valid.
 *  - `refresh-pending`: the access token has expired but a refresh token is present. This is a
 *    normal idle login; codex refreshes it on the next run, so it counts as signed in.
 *  - `unusable`: the file is unparseable, or there is neither a valid access token nor a refresh token.
 *  - `unknown`: nothing to judge (no file, e.g. keyring storage; an API key login; no exp claim).
 *  A used or revoked refresh token cannot be told apart without a network refresh, which would
 *  rotate the token, so that case is left to run-time evidence (the 401 hint in #2494 and the
 *  per-run breaker in #2495). Reads only: no network call and no refresh. Never throws. */
export type CodexSessionState = 'ok' | 'refresh-pending' | 'unusable' | 'unknown';

export function codexChatgptSessionState(deps: CodexLoginEvidenceDeps = {}): CodexSessionState {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? osHomedir;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const now = deps.now ?? Date.now;
  let text: string;
  try {
    const dir = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    text = readFile(join(dir, 'auth.json'));
  } catch {
    return 'unknown';
  }
  let auth: { OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown; refresh_token?: unknown } | null };
  try {
    auth = JSON.parse(text) as typeof auth;
  } catch {
    return 'unusable';
  }
  if (typeof auth !== 'object' || auth === null) return 'unusable';
  if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) return 'unknown';
  const refresh = auth.tokens?.refresh_token;
  const hasRefresh = typeof refresh === 'string' && refresh.trim().length > 0;
  const access = auth.tokens?.access_token;
  let exp: unknown;
  try {
    const payload = typeof access === 'string' ? access.split('.')[1] : undefined;
    exp = payload
      ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp
      : undefined;
  } catch {
    exp = undefined;
  }
  if (typeof exp === 'number' && exp * 1000 > now() + EXPIRY_SKEW_MS) return 'ok';
  if (hasRefresh) return 'refresh-pending';
  return typeof access === 'string' && typeof exp !== 'number' && access.length > 0 ? 'unknown' : 'unusable';
}

const defaultExec = (file: string, args: readonly string[]): void => {
  execFileSync(file, [...args], { stdio: 'ignore', timeout: 10_000 });
};

/** True when the codex CLI has a usable login, found without any inference call (#2418).
 *  Evidence order: CODEX_API_KEY set (non-empty); `codex login status` exits 0 (it reads stored
 *  credentials from auth.json or the keyring and makes no model request), unless the stored
 *  ChatGPT session is unusable (#2509). An expired access token with a refresh token still counts. */
export function hasCodexLoginEvidence(deps: CodexLoginEvidenceDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  if (env.CODEX_API_KEY?.trim()) return true;
  try {
    exec('codex', ['login', 'status']);
    return codexChatgptSessionState(deps) !== 'unusable';
  } catch {
    return false;
  }
}

/** True when a Codex API key is configured (OPENAI_API_KEY or CODEX_API_KEY in env, or a non-empty
 *  OPENAI_API_KEY string in `$CODEX_HOME/auth.json`), which makes calls metered (#3214). Boolean only,
 *  never the key. Never throws. */
export function codexHasApiKey(deps: CodexLoginEvidenceDeps = {}): boolean {
  try {
    const env = deps.env ?? process.env;
    if (env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim()) return true;
    const homedir = deps.homedir ?? osHomedir;
    const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const dir = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    const auth = JSON.parse(readFile(join(dir, 'auth.json'))) as { OPENAI_API_KEY?: unknown } | null;
    return (
      typeof auth === 'object' &&
      auth !== null &&
      typeof auth.OPENAI_API_KEY === 'string' &&
      auth.OPENAI_API_KEY.trim().length > 0
    );
  } catch {
    return false;
  }
}
