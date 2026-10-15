// src/utils/local-auth-record.ts — the last run-time local_auth failure per agent (#2733, #2890 adds opencode).
//
// A refresh token that is present but already used or revoked looks fine on disk, and doctor
// must not refresh it to find out (that would burn the token). So when a run hits local_auth,
// the router records "<agent> failed local_auth at <time>" here, and doctor / models --doctor
// fail that agent while the failure is newer than its credential file's mtime. A new login
// rewrites the credential file, which clears the failure without touching this record.
//
// Machine-level state under ~/.factory/auth (credentials are per machine, not per repo, and
// doctor can run outside a repo). Stores only the agent name and a timestamp: never a
// credential value. Every function here never throws.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { claudeConfigDirPath } from './claude-config.js';

export type LocalAuthAgent = 'claude' | 'codex' | 'opencode';

export interface LocalAuthRecordDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  now?: () => number;
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string) => void;
  /** mtime in ms, throws when missing. */
  mtimeMs?: (path: string) => number;
}

export interface LocalAuthFailure {
  agent: LocalAuthAgent;
  /** ISO timestamp of the failure. */
  at: string;
}

/** `~/.factory/auth/local-auth-failures.json`. */
export function localAuthRecordPath(deps: LocalAuthRecordDeps = {}): string {
  return join((deps.homedir ?? osHomedir)(), '.factory', 'auth', 'local-auth-failures.json');
}

/** Maps a harness id (or provider) to the agent whose login it uses; undefined for others. */
export function localAuthAgentFor(harnessOrProvider: string | undefined): LocalAuthAgent | undefined {
  if (harnessOrProvider === 'claude-cli' || harnessOrProvider === 'anthropic') return 'claude';
  if (harnessOrProvider === 'codex-cli') return 'codex';
  if (harnessOrProvider === 'opencode') return 'opencode';
  return undefined;
}

/** Credential file whose mtime marks the agent's latest login (opencode's is written by `opencode auth login`). */
export function localAuthCredentialPath(agent: LocalAuthAgent, deps: LocalAuthRecordDeps = {}): string {
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? osHomedir)();
  if (agent === 'claude') return resolve(claudeConfigDirPath(env, home), '.credentials.json');
  if (agent === 'opencode') {
    return join(env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'), 'opencode', 'auth.json');
  }
  return join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'auth.json');
}

function readAll(deps: LocalAuthRecordDeps): Partial<Record<LocalAuthAgent, LocalAuthFailure>> {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  try {
    const parsed = JSON.parse(readFile(localAuthRecordPath(deps))) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Partial<Record<LocalAuthAgent, LocalAuthFailure>> = {};
    for (const agent of ['claude', 'codex', 'opencode'] as const) {
      const at = (parsed as Record<string, { at?: unknown } | undefined>)[agent]?.at;
      if (typeof at === 'string' && Number.isFinite(Date.parse(at))) out[agent] = { agent, at };
    }
    return out;
  } catch {
    return {};
  }
}

/** Records that `agent` just failed local_auth. Best effort; never throws. */
export function recordLocalAuthFailure(agent: LocalAuthAgent, deps: LocalAuthRecordDeps = {}): void {
  const now = deps.now ?? Date.now;
  const path = localAuthRecordPath(deps);
  const write =
    deps.writeFile ??
    ((p: string, text: string) => {
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, p);
    });
  try {
    const all = readAll(deps);
    all[agent] = { agent, at: new Date(now()).toISOString() };
    write(path, `${JSON.stringify(all, null, 2)}\n`);
  } catch {
    // bookkeeping only: never fail a run over it
  }
}

/** The recorded local_auth failure for `agent` when it is newer than the agent's credential
 *  file mtime (no login since), else null. With no credential file (macOS keychain storage,
 *  env-token auth) nothing dates the latest login, and a re-login would never clear the
 *  failure, so it is not reported (null) rather than failing doctor forever. Never throws. */
export function localAuthFailureSinceLogin(
  agent: LocalAuthAgent,
  deps: LocalAuthRecordDeps = {},
): LocalAuthFailure | null {
  const failure = readAll(deps)[agent];
  if (!failure) return null;
  const mtimeMs = deps.mtimeMs ?? ((p: string) => statSync(p).mtimeMs);
  let loginAt: number;
  try {
    loginAt = mtimeMs(localAuthCredentialPath(agent, deps));
  } catch {
    return null;
  }
  return Date.parse(failure.at) > loginAt ? failure : null;
}
