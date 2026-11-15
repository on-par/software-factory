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
  mtimeMs?: (path: string) => number;
}

export interface LocalAuthFailure {
  agent: LocalAuthAgent;
  at: string;
}

export function localAuthRecordPath(deps: LocalAuthRecordDeps = {}): string {
  return join((deps.homedir ?? osHomedir)(), '.factory', 'auth', 'local-auth-failures.json');
}

export function localAuthAgentFor(harnessOrProvider: string | undefined): LocalAuthAgent | undefined {
  if (harnessOrProvider === 'claude-cli' || harnessOrProvider === 'anthropic') return 'claude';
  if (harnessOrProvider === 'codex-cli') return 'codex';
  if (harnessOrProvider === 'opencode') return 'opencode';
  return undefined;
}

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
  } catch {}
}

export function localAuthFailureSinceLogin(
  agent: LocalAuthAgent,
  deps: LocalAuthRecordDeps = {},
): LocalAuthFailure | null {
  const failure = readAll(deps)[agent];
  if (!failure) return null;
  const mtimeMs = deps.mtimeMs ?? ((p: string) => statSync(p).mtimeMs);
  let latestLoginAt: number;
  try {
    latestLoginAt = mtimeMs(localAuthCredentialPath(agent, deps));
  } catch {
    return null;
  }
  return Date.parse(failure.at) > latestLoginAt ? failure : null;
}
