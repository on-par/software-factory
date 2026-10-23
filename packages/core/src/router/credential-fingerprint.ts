// src/router/credential-fingerprint.ts — sha256 fingerprint of a provider's credential sources, so the breaker can
// hold a provider whose credential was rejected until the credentials change (#3232). Never returns or logs raw values.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join, resolve } from 'node:path';

import { claudeConfigDirPath } from '../utils/claude-config.js';

export interface CredentialFingerprintDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  readFile?: (p: string) => Buffer | string;
  statMtimeMs?: (p: string) => number;
}

interface CredentialSources {
  files: string[];
  envVars: string[];
}

const ANTHROPIC_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
];
const OPENAI_ENV = ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'];

/** Auth files and env vars whose change means the provider's credentials changed. Unknown providers get every source. */
export function credentialSourcesFor(provider: string, deps: CredentialFingerprintDeps = {}): CredentialSources {
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? osHomedir)();
  const anthropic: CredentialSources = {
    files: [resolve(claudeConfigDirPath(env, home), '.credentials.json')],
    envVars: ANTHROPIC_ENV,
  };
  const openai: CredentialSources = {
    files: [join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json')],
    envVars: OPENAI_ENV,
  };
  if (provider === 'anthropic') return anthropic;
  if (provider === 'openai') return openai;
  return {
    files: [
      ...anthropic.files,
      ...openai.files,
      join(env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'), 'opencode', 'auth.json'),
    ],
    envVars: [...anthropic.envVars, ...openai.envVars, 'XDG_DATA_HOME'],
  };
}

function fileState(path: string, deps: CredentialFingerprintDeps): string {
  try {
    const mtime = (deps.statMtimeMs ?? ((p: string) => statSync(p).mtimeMs))(path);
    const content = (deps.readFile ?? ((p: string) => readFileSync(p)))(path);
    return `${mtime}\0${content.toString()}`;
  } catch {
    return '<missing>';
  }
}

/** sha256 hex over the mtime and content of each auth file and the value of each env var. Never throws. */
export function credentialFingerprint(provider: string, deps: CredentialFingerprintDeps = {}): string {
  const env = deps.env ?? process.env;
  const { files, envVars } = credentialSourcesFor(provider, deps);
  const hash = createHash('sha256');
  for (const file of [...files].sort()) hash.update(`${file}\0${fileState(file, deps)}\n`);
  for (const name of [...envVars].sort()) hash.update(`${name}\0${env[name] ?? '<unset>'}\n`);
  return hash.digest('hex');
}
