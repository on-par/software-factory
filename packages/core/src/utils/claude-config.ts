import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_SERVICE_HASH_HEX_LENGTH = 8;
const CREDENTIALS_FILE_NAME = '.credentials.json';

export function claudeConfigDirOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CLAUDE_CONFIG_DIR;
  return raw ? raw.normalize('NFC') : undefined;
}

export function claudeConfigDirPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return resolve(claudeConfigDirOverride(env) ?? resolve(home, '.claude'));
}

function claudeCredentialsFilePath(env: NodeJS.ProcessEnv): string {
  return resolve(claudeConfigDirPath(env), CREDENTIALS_FILE_NAME);
}

export function claudeKeychainService(env: NodeJS.ProcessEnv = process.env): string {
  const secureStorageDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const hashedDir = secureStorageDir !== undefined ? secureStorageDir.normalize('NFC') : claudeConfigDirOverride(env);
  if (!hashedDir) return DEFAULT_CLAUDE_KEYCHAIN_SERVICE;
  const dirHash = createHash('sha256').update(hashedDir).digest('hex');
  return `${DEFAULT_CLAUDE_KEYCHAIN_SERVICE}-${dirHash.slice(0, KEYCHAIN_SERVICE_HASH_HEX_LENGTH)}`;
}

export interface ClaudeLoginEvidenceDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exec?: (file: string, args: readonly string[]) => void;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  now?: () => number;
}

const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export type ClaudeSessionState = 'ok' | 'refresh-pending' | 'unusable' | 'unknown';

export function claudeStoredSessionState(deps: ClaudeLoginEvidenceDeps = {}): ClaudeSessionState {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const now = deps.now ?? Date.now;
  let text: string;
  try {
    text = readFile(claudeCredentialsFilePath(env));
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

function hasKeychainEntry(exec: (file: string, args: readonly string[]) => void, env: NodeJS.ProcessEnv): boolean {
  try {
    exec('security', ['find-generic-password', '-s', claudeKeychainService(env)]);
    return true;
  } catch {
    return false;
  }
}

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
  if (platform === 'darwin' && hasKeychainEntry(exec, env)) return true;
  try {
    if (!fileExists(claudeCredentialsFilePath(env))) return false;
  } catch {
    return false;
  }
  try {
    return claudeStoredSessionState(deps) !== 'unusable';
  } catch {
    return false;
  }
}

export type ProviderPlan = 'subscription' | 'api' | 'unknown';

export function detectClaudePlan(deps: ClaudeLoginEvidenceDeps = {}): ProviderPlan {
  try {
    const env = deps.env ?? process.env;
    if (env.ANTHROPIC_API_KEY?.trim()) return 'api';
    return hasClaudeLoginEvidence(deps) ? 'subscription' : 'unknown';
  } catch {
    return 'unknown';
  }
}
