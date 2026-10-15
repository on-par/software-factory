import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  localAuthAgentFor,
  localAuthCredentialPath,
  localAuthFailureSinceLogin,
  localAuthRecordPath,
  recordLocalAuthFailure,
} from './local-auth-record.js';

describe('local auth record (#2733)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const home = () => {
    const d = mkdtempSync(join(tmpdir(), 'lar-'));
    dirs.push(d);
    return d;
  };

  it('maps harness ids and providers to agents', () => {
    expect(localAuthAgentFor('claude-cli')).toBe('claude');
    expect(localAuthAgentFor('anthropic')).toBe('claude');
    expect(localAuthAgentFor('codex-cli')).toBe('codex');
    expect(localAuthAgentFor('opencode')).toBe('opencode');
    expect(localAuthAgentFor('pi')).toBeUndefined();
    expect(localAuthAgentFor('ollama-http')).toBeUndefined();
    expect(localAuthAgentFor(undefined)).toBeUndefined();
  });

  it('resolves the record and credential paths', () => {
    const deps = { homedir: () => '/h', env: {} };
    expect(localAuthRecordPath(deps)).toBe(join('/h', '.factory', 'auth', 'local-auth-failures.json'));
    expect(localAuthCredentialPath('claude', deps)).toBe(resolve('/h/.claude/.credentials.json'));
    expect(localAuthCredentialPath('codex', deps)).toBe(join('/h', '.codex', 'auth.json'));
    expect(localAuthCredentialPath('opencode', deps)).toBe(join('/h', '.local', 'share', 'opencode', 'auth.json'));
    expect(localAuthCredentialPath('opencode', { ...deps, env: { XDG_DATA_HOME: '/x' } })).toBe(
      join('/x', 'opencode', 'auth.json'),
    );
    expect(localAuthCredentialPath('opencode', { ...deps, env: { XDG_DATA_HOME: '  ' } })).toBe(
      join('/h', '.local', 'share', 'opencode', 'auth.json'),
    );
    expect(localAuthCredentialPath('claude', { ...deps, env: { CLAUDE_CONFIG_DIR: '/p' } })).toBe(
      resolve('/p/.credentials.json'),
    );
    expect(localAuthCredentialPath('codex', { ...deps, env: { CODEX_HOME: '/c' } })).toBe(join('/c', 'auth.json'));
  });

  it('records only the agent and a timestamp, keeping the other agent', () => {
    const h = home();
    const deps = { homedir: () => h, env: {}, now: () => Date.UTC(2026, 9, 13, 16) };
    recordLocalAuthFailure('codex', deps);
    recordLocalAuthFailure('claude', deps);
    const saved = JSON.parse(readFileSync(localAuthRecordPath(deps), 'utf8')) as Record<string, unknown>;
    expect(saved).toEqual({
      codex: { agent: 'codex', at: '2026-10-13T16:00:00.000Z' },
      claude: { agent: 'claude', at: '2026-10-13T16:00:00.000Z' },
    });
  });

  it('reports a failure newer than the credential file, and clears it after a new login', () => {
    const h = home();
    const env = {};
    const cred = localAuthCredentialPath('claude', { homedir: () => h, env });
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(cred, '{}');
    const loginAt = Date.UTC(2026, 9, 13, 15) / 1000;
    utimesSync(cred, loginAt, loginAt);
    recordLocalAuthFailure('claude', { homedir: () => h, env, now: () => Date.UTC(2026, 9, 13, 16) });
    expect(localAuthFailureSinceLogin('claude', { homedir: () => h, env })).toEqual({
      agent: 'claude',
      at: '2026-10-13T16:00:00.000Z',
    });
    expect(localAuthFailureSinceLogin('codex', { homedir: () => h, env })).toBeNull();
    const relogin = Date.UTC(2026, 9, 13, 17) / 1000;
    utimesSync(cred, relogin, relogin);
    expect(localAuthFailureSinceLogin('claude', { homedir: () => h, env })).toBeNull();
  });

  it('records an opencode failure with an ISO timestamp, keeping claude and codex (#2890)', () => {
    const h = home();
    const deps = { homedir: () => h, env: {}, now: () => Date.UTC(2026, 9, 14, 9) };
    recordLocalAuthFailure('claude', deps);
    recordLocalAuthFailure('opencode', deps);
    const saved = JSON.parse(readFileSync(localAuthRecordPath(deps), 'utf8')) as Record<string, unknown>;
    expect(saved).toEqual({
      claude: { agent: 'claude', at: '2026-10-14T09:00:00.000Z' },
      opencode: { agent: 'opencode', at: '2026-10-14T09:00:00.000Z' },
    });
  });

  it('reports an opencode failure newer than auth.json and clears it after a new login (#2890)', () => {
    const h = home();
    const env = { XDG_DATA_HOME: join(h, 'xdg') };
    const deps = { homedir: () => h, env };
    expect(localAuthFailureSinceLogin('opencode', deps)).toBeNull();
    const cred = localAuthCredentialPath('opencode', deps);
    mkdirSync(join(h, 'xdg', 'opencode'), { recursive: true });
    writeFileSync(cred, '{}');
    const loginAt = Date.UTC(2026, 9, 14, 8) / 1000;
    utimesSync(cred, loginAt, loginAt);
    recordLocalAuthFailure('opencode', { ...deps, now: () => Date.UTC(2026, 9, 14, 9) });
    expect(localAuthFailureSinceLogin('opencode', deps)).toEqual({
      agent: 'opencode',
      at: '2026-10-14T09:00:00.000Z',
    });
    const relogin = Date.UTC(2026, 9, 14, 10) / 1000;
    utimesSync(cred, relogin, relogin);
    expect(localAuthFailureSinceLogin('opencode', deps)).toBeNull();
  });

  it('does not report a failure with no credential file to date the login', () => {
    const h = home();
    recordLocalAuthFailure('codex', { homedir: () => h, env: {} });
    expect(localAuthFailureSinceLogin('codex', { homedir: () => h, env: {} })).toBeNull();
  });

  it('ignores a missing, malformed or partial record', () => {
    const deps = (text: string) => ({
      homedir: () => '/h',
      env: {},
      readFile: () => text,
      mtimeMs: () => 0,
    });
    expect(
      localAuthFailureSinceLogin('claude', {
        homedir: () => '/h',
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeNull();
    expect(localAuthFailureSinceLogin('claude', deps('{nope'))).toBeNull();
    expect(localAuthFailureSinceLogin('claude', deps('null'))).toBeNull();
    expect(localAuthFailureSinceLogin('claude', deps('{"claude":{"at":"not a date"}}'))).toBeNull();
    expect(localAuthFailureSinceLogin('claude', deps('{"claude":{"at":"2026-10-13T16:00:00Z"}}'))).toEqual({
      agent: 'claude',
      at: '2026-10-13T16:00:00Z',
    });
  });

  it('never throws when the record cannot be written', () => {
    expect(() =>
      recordLocalAuthFailure('claude', {
        homedir: () => '/h',
        readFile: () => '{}',
        writeFile: () => {
          throw new Error('EROFS');
        },
      }),
    ).not.toThrow();
  });
});
