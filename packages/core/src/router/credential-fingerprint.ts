// src/router/credential-fingerprint.ts — sha256 over a provider's credential files and env vars, so an
// auth breaker can tell "the credentials changed" from "the same rejected credentials" (#3232).
// Only the hex digest leaves this module; no key material is stored or logged.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { claudeConfigDirPath } from '../utils/claude-config.js';

export interface CredentialSources {
  files: string[];
  envVars: string[];
}

export interface CredentialFingerprintDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stat?: (path: string) => Promise<{ mtimeMs: number }>;
  readFile?: (path: string) => Promise<string>;
}

function claudeSources(env: NodeJS.ProcessEnv, home: string): CredentialSources {
  return {
    files: [resolve(claudeConfigDirPath(env, home), '.credentials.json')],
    envVars: ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  };
}

function codexSources(env: NodeJS.ProcessEnv, home: string): CredentialSources {
  return {
    files: [join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json')],
    envVars: ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
  };
}

/** Where `provider`'s credentials live. Providers without a dedicated set (ollama, custom, unknown) get the union
 *  of every known source, so any credential change closes their breaker. */
export function credentialSources(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): CredentialSources {
  if (provider === 'anthropic') return claudeSources(env, home);
  if (provider === 'openai') return codexSources(env, home);
  const claude = claudeSources(env, home);
  const codex = codexSources(env, home);
  return {
    files: [
      ...claude.files,
      ...codex.files,
      join(env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'), 'opencode', 'auth.json'),
    ],
    envVars: [...claude.envVars, ...codex.envVars, 'XDG_DATA_HOME'],
  };
}

/** Hex sha256 over the provider's credential files (mtime + content) and env vars. Never throws:
 *  an unreadable file counts as missing. */
export async function credentialFingerprint(provider: string, deps: CredentialFingerprintDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const statFn = deps.stat ?? ((path: string) => stat(path));
  const readFn = deps.readFile ?? ((path: string) => readFile(path, 'utf-8'));
  const sources = credentialSources(provider, env, (deps.homedir ?? homedir)());
  const hash = createHash('sha256');
  for (const file of [...sources.files].sort()) {
    let mtime = 'missing';
    let content = 'missing';
    try {
      mtime = String((await statFn(file)).mtimeMs);
      content = await readFn(file);
    } catch {
      mtime = 'missing';
      content = 'missing';
    }
    hash.update(`file\0${file}\0${mtime}\0${content}\0`);
  }
  for (const name of [...sources.envVars].sort()) {
    hash.update(`env\0${name}\0${env[name] ?? 'unset'}\0`);
  }
  return hash.digest('hex');
}
