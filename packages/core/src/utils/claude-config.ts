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

import { createHash } from 'node:crypto';
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
