import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

export interface CodexLoginEvidenceDeps {
  env?: NodeJS.ProcessEnv;
  exec?: (file: string, args: readonly string[]) => void;
  homedir?: () => string;
  readFile?: (path: string) => string;
  now?: () => number;
}

const EXPIRY_SKEW_MS = 5 * 60 * 1000;

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
