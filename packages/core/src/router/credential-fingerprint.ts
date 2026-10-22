// src/router/credential-fingerprint.ts — hash of a provider's credential inputs, so an auth breaker
// can tell "credentials changed" from "still the same rejected key" without storing key material (#3232).

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { claudeConfigDirPath } from '../utils/claude-config.js';

export interface CredentialFingerprintDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stat?: (path: string) => Promise<{ mtimeMs: number }>;
  readFile?: (path: string) => Promise<Buffer | string>;
}

/** The auth files and env var names whose values make up a provider's credentials. The darwin keychain entry
 *  for Claude is not hashed (reading it needs a secret read); rotating it needs `factory breaker reset`. */
export function credentialInputs(
  provider: string,
  deps: CredentialFingerprintDeps = {},
): { files: string[]; env: string[] } {
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? homedir)();
  if (provider === 'anthropic') {
    return {
      files: [join(claudeConfigDirPath(env, home), '.credentials.json')],
      env: ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    };
  }
  if (provider === 'openai') {
    return {
      files: [join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json')],
      env: ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
    };
  }
  return {
    files: [join(env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'), 'opencode', 'auth.json')],
    env: ['XDG_DATA_HOME'],
  };
}

/** sha256 hex over the mtime and content of the provider's auth files and the values of its credential env vars.
 *  Never throws; never returns or logs a raw value. */
export async function credentialFingerprint(provider: string, deps: CredentialFingerprintDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const statFile = deps.stat ?? stat;
  const read = deps.readFile ?? readFile;
  const inputs = credentialInputs(provider, deps);
  const hash = createHash('sha256');
  for (const path of inputs.files) {
    hash.update(path);
    try {
      const { mtimeMs } = await statFile(path);
      const content = await read(path);
      hash.update(String(mtimeMs));
      hash.update(content);
    } catch {
      hash.update('\0missing');
    }
  }
  for (const name of inputs.env) hash.update(`${name}=${env[name] ?? ''}`);
  return hash.digest('hex');
}
