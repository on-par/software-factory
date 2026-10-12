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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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
}

/** True when this machine holds evidence of a Claude Code login for the selected profile,
 *  found without running `claude` or any inference/network call (#2417). Evidence order:
 *  CLAUDE_CODE_OAUTH_TOKEN set (non-empty); on darwin, the profile's keychain entry exists
 *  (`security find-generic-password -s <service>` without -w, so no secret is read);
 *  `<config dir>/.credentials.json` exists. Never throws. */
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
    return fileExists(resolve(claudeConfigDirPath(env), '.credentials.json'));
  } catch {
    return false;
  }
}
