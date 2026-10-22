import { describe, expect, it, vi } from 'vitest';
import { codexChatgptSessionState, codexHasApiKey, hasCodexLoginEvidence } from './codex-config.js';

const noFile = () => {
  throw new Error('ENOENT');
};

describe('hasCodexLoginEvidence', () => {
  it('returns true for a non-empty CODEX_API_KEY without running anything', () => {
    const exec = vi.fn();
    expect(hasCodexLoginEvidence({ env: { CODEX_API_KEY: 'sk-test' }, exec })).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('ignores a whitespace-only CODEX_API_KEY and falls through to login status', () => {
    const exec = vi.fn();
    expect(hasCodexLoginEvidence({ env: { CODEX_API_KEY: '   ' }, exec, readFile: noFile })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('runs only `codex login status` and never codex exec', () => {
    const exec = vi.fn();
    expect(hasCodexLoginEvidence({ env: {}, exec, readFile: noFile })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('codex', ['login', 'status']);
    expect(exec.mock.calls.some(([, args]) => (args as string[]).includes('exec'))).toBe(false);
  });

  it('returns false when the command throws (non-zero exit or not found)', () => {
    const exec = vi.fn(() => {
      throw new Error('exit 1');
    });
    expect(hasCodexLoginEvidence({ env: {}, exec, readFile: noFile })).toBe(false);
  });

  it('does not throw with real defaults', () => {
    expect(typeof hasCodexLoginEvidence({ env: {} })).toBe('boolean');
  });
});

interface AuthFile {
  OPENAI_API_KEY?: string;
  auth_mode?: string;
  tokens?: { access_token?: string; refresh_token?: string };
}

describe('codexChatgptSessionState (#2509)', () => {
  const NOW = Date.UTC(2026, 9, 12);
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
  const raw = (text: string) => (path: string) => {
    expect(path).toBe('/codex-home/auth.json');
    return text;
  };
  const depsRaw = (text: string) => ({ env: { CODEX_HOME: '/codex-home' }, readFile: raw(text), now: () => NOW });
  const deps = (body: AuthFile) => depsRaw(JSON.stringify(body));
  const expired = jwt(NOW / 1000 - 3600);

  it('treats an expired access token with a refresh token as a normal, refreshable login', () => {
    const body = { auth_mode: 'chatgpt', tokens: { access_token: expired, refresh_token: 'r' } };
    expect(codexChatgptSessionState(deps(body))).toBe('refresh-pending');
    expect(hasCodexLoginEvidence({ ...deps(body), exec: vi.fn() })).toBe(true);
  });

  it('accepts an access token that is still valid', () => {
    expect(codexChatgptSessionState(deps({ tokens: { access_token: jwt(NOW / 1000 + 3600) } }))).toBe('ok');
  });

  it('flags an expired access token with no or an empty refresh token', () => {
    expect(codexChatgptSessionState(deps({ tokens: { access_token: expired } }))).toBe('unusable');
    expect(codexChatgptSessionState(deps({ tokens: { access_token: expired, refresh_token: '  ' } }))).toBe('unusable');
    expect(hasCodexLoginEvidence({ ...deps({ tokens: { access_token: expired } }), exec: vi.fn() })).toBe(false);
  });

  it('flags an unparseable file and a file with no tokens', () => {
    expect(codexChatgptSessionState(depsRaw('{not json'))).toBe('unusable');
    expect(codexChatgptSessionState(deps({}))).toBe('unusable');
  });

  it('leaves an API key login, a missing file and an opaque token to codex login status', () => {
    expect(codexChatgptSessionState(deps({ OPENAI_API_KEY: 'k', tokens: { access_token: jwt(0) } }))).toBe('unknown');
    expect(codexChatgptSessionState({ env: { CODEX_HOME: '/x' }, readFile: noFile })).toBe('unknown');
    expect(codexChatgptSessionState(deps({ tokens: { access_token: 'not-a-jwt' } }))).toBe('unknown');
  });

  it('still fails when codex login status fails', () => {
    const exec = vi.fn(() => {
      throw new Error('exit 1');
    });
    const body = { tokens: { access_token: jwt(NOW / 1000 + 3600), refresh_token: 'r' } };
    expect(hasCodexLoginEvidence({ ...deps(body), exec })).toBe(false);
  });
});

describe('codexHasApiKey', () => {
  const file = (body: string) => ({ env: { CODEX_HOME: '/c' }, readFile: () => body });

  it('is true for an env key without reading the file', () => {
    const readFile = vi.fn(noFile);
    expect(codexHasApiKey({ env: { OPENAI_API_KEY: 'k' }, readFile })).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('is true for an auth.json key and reads it from CODEX_HOME', () => {
    const readFile = vi.fn(() => JSON.stringify({ OPENAI_API_KEY: 'k' }));
    expect(codexHasApiKey({ env: { CODEX_HOME: '/c' }, readFile })).toBe(true);
    expect(readFile).toHaveBeenCalledWith('/c/auth.json');
  });

  it('is false for whitespace, non-string, missing or unparseable keys', () => {
    expect(codexHasApiKey({ env: { OPENAI_API_KEY: '  ' }, readFile: noFile })).toBe(false);
    expect(codexHasApiKey(file(JSON.stringify({ OPENAI_API_KEY: ' ' })))).toBe(false);
    expect(codexHasApiKey(file(JSON.stringify({ OPENAI_API_KEY: 5 })))).toBe(false);
    expect(codexHasApiKey(file('null'))).toBe(false);
    expect(codexHasApiKey({ env: {}, homedir: () => '/h', readFile: noFile })).toBe(false);
    expect(codexHasApiKey(file('{not json'))).toBe(false);
  });
});
