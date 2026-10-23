// src/utils/claude-config.ts — which Claude Code profile (config dir + keychain entry)
// the factory is running against.
//
// Claude Code reads everything per-profile from CLAUDE_CONFIG_DIR when it is set
// (credentials, .claude.json, projects/ transcripts), and stores its macOS OAuth
// credential under a keychain service suffixed with a hash of that dir. Child `claude`
// processes inherit the env, so the factory's own reads of that state must resolve the
// same profile, or the usage gate, transcript estimator, sandbox allowlist, and doctor
// would silently look at the default ~/.claude profile instead.
//
// The naming below mirrors Claude Code 2.1.284 (verified against the shipped bundle):
//   configDir = (CLAUDE_CONFIG_DIR ?? ~/.claude).normalize('NFC')   — not path-resolved
//   service   = 'Claude Code-credentials' + (CLAUDE_CONFIG_DIR ? `-${sha256(configDir).hex.slice(0, 8)}` : '')
// with CLAUDE_SECURESTORAGE_CONFIG_DIR, when defined, overriding which dir the service
// hash is taken from. A leaf module: node built-ins only, so microvm.ts can import it.
//
// hasClaudeLoginEvidence answers "is there a stored login?" without running `claude` or
// reading any secret (env var, keychain entry existence, credentials file existence).
// detectClaudePlan sits on top of it: an API key wins, else a login means a subscription.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** CLAUDE_CONFIG_DIR when set to a non-empty value, else undefined (the default profile). */
export function claudeConfigDirOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CLAUDE_CONFIG_DIR;
  return raw ? raw.normalize('NFC') : undefined;
}

/** Absolute filesystem path of the selected profile's config dir: CLAUDE_CONFIG_DIR, or
 *  ~/.claude when unset. */
export function claudeConfigDirPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return resolve(claudeConfigDirOverride(env) ?? resolve(home, '.claude'));
}

/** The macOS keychain service Claude Code stores the selected profile's OAuth credential
 *  under. Unchanged ('Claude Code-credentials') when CLAUDE_CONFIG_DIR is unset. The hash
 *  is over the dir exactly as spelled in the env (not path-resolved), as Claude Code does. */
export function claudeKeychainService(env: NodeJS.ProcessEnv = process.env): string {
  const secureStorageDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const hashedDir = secureStorageDir !== undefined ? secureStorageDir.normalize('NFC') : claudeConfigDirOverride(env);
  if (!hashedDir) return DEFAULT_CLAUDE_KEYCHAIN_SERVICE;
  return `${DEFAULT_CLAUDE_KEYCHAIN_SERVICE}-${createHash('sha256').update(hashedDir).digest('hex').slice(0, 8)}`;
}

export interface ClaudeLoginEvidenceDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Runs a command, throws on non-zero exit. Default: execFileSync with stdio 'ignore'. */
  exec?: (file: string, args: readonly string[]) => void;
  fileExists?: (path: string) => boolean;
  /** Reads a file as utf8, throws when missing. Default: readFileSync. */
  readFile?: (path: string) => string;
  now?: () => number;
}

/** Margin so a token about to lapse mid-run already counts as expired. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** State of the stored Claude Code OAuth login in `<config dir>/.credentials.json` (#2721,
 *  the Claude twin of #2509).
 *  - `ok`: the access token is still valid.
 *  - `refresh-pending`: the access token has expired but a refresh token is present. A normal
 *    idle login; claude refreshes it on the next run, so it counts as signed in.
 *  - `unusable`: the file is unparseable, or there is neither a live access token nor a refresh token.
 *  - `unknown`: nothing to judge (no file, e.g. macOS keychain storage; no claudeAiOauth entry;
 *    no expiry recorded).
 *  A rotated or revoked refresh token cannot be told apart without a network refresh, which would
 *  rotate the token, so that is left to run-time evidence (the local_auth class). Reads only: no
 *  network call, no refresh, never returns or logs a credential value. Never throws. */
export type ClaudeSessionState = 'ok' | 'refresh-pending' | 'unusable' | 'unknown';

export function claudeStoredSessionState(deps: ClaudeLoginEvidenceDeps = {}): ClaudeSessionState {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const now = deps.now ?? Date.now;
  let text: string;
  try {
    text = readFile(resolve(claudeConfigDirPath(env), '.credentials.json'));
  } catch {
    return 'unknown';
  }
  let creds: unknown;
  try {
    creds = JSON.parse(text);
  } catch {
    return 'unusable';
  }
  if (typeof creds !== 'object' || creds === null) return 'unusable';
  const oauth = (creds as { claudeAiOauth?: unknown }).claudeAiOauth;
  // No Claude.ai OAuth entry (e.g. only MCP OAuth state): nothing to judge, keep file-existence evidence.
  if (typeof oauth !== 'object' || oauth === null) return 'unknown';
  const { accessToken, refreshToken, expiresAt } = oauth as {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  };
  const hasAccess = typeof accessToken === 'string' && accessToken.trim().length > 0;
  const hasRefresh = typeof refreshToken === 'string' && refreshToken.trim().length > 0;
  if (hasAccess && typeof expiresAt === 'number' && expiresAt > now() + EXPIRY_SKEW_MS) return 'ok';
  if (hasRefresh) return 'refresh-pending';
  if (hasAccess && typeof expiresAt !== 'number') return 'unknown';
  return 'unusable';
}

/** True when this machine holds evidence of a Claude Code login for the selected profile,
 *  found without running `claude` or any inference/network call (#2417). Evidence order:
 *  CLAUDE_CODE_OAUTH_TOKEN set (non-empty); on darwin, the profile's keychain entry exists
 *  (`security find-generic-password -s <service>` without -w, so no secret is read);
 *  `<config dir>/.credentials.json` exists and its session is not unusable (#2721: an expired
 *  access token with no refresh token is not a login). Never throws. */
export function hasClaudeLoginEvidence(deps: ClaudeLoginEvidenceDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exec =
    deps.exec ??
    ((file: string, args: readonly string[]) => {
      execFileSync(file, [...args], { stdio: 'ignore', timeout: 10_000 });
    });
  const fileExists = deps.fileExists ?? existsSync;

  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  if (platform === 'darwin') {
    try {
      exec('security', ['find-generic-password', '-s', claudeKeychainService(env)]);
      return true;
    } catch {
      // no keychain entry, or the keychain is unreadable here — fall through to the file
    }
  }
  try {
    if (!fileExists(resolve(claudeConfigDirPath(env), '.credentials.json'))) return false;
  } catch {
    return false;
  }
  try {
    return claudeStoredSessionState(deps) !== 'unusable';
  } catch {
    return false;
  }
}

/** How a provider's calls are billed on this machine: a flat subscription login, a metered API key, or unknown. */
export type ProviderPlan = 'subscription' | 'api' | 'unknown';

/** The selected Claude Code profile's billing plan (#3214): 'api' when ANTHROPIC_API_KEY is set (non-empty),
 *  even when a stored login also exists (the order doctor and Claude Code use); else 'subscription'
 *  when hasClaudeLoginEvidence finds a login; else 'unknown'. Never reads or logs a credential value,
 *  never runs `claude`, never throws. */
export function detectClaudePlan(deps: ClaudeLoginEvidenceDeps = {}): ProviderPlan {
  try {
    const env = deps.env ?? process.env;
    if (env.ANTHROPIC_API_KEY?.trim()) return 'api';
    return hasClaudeLoginEvidence(deps) ? 'subscription' : 'unknown';
  } catch {
    return 'unknown';
  }
}
