import { describe, expect, it, vi } from 'vitest';
import { codexChatgptSessionExpired, hasCodexLoginEvidence } from './codex-config.js';

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

describe('codexChatgptSessionExpired (#2509)', () => {
  const NOW = Date.UTC(2026, 9, 12);
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
  const auth = (body: AuthFile) => (path: string) => {
    expect(path).toBe('/codex-home/auth.json');
    return JSON.stringify(body);
  };
  const deps = (body: AuthFile) => ({ env: { CODEX_HOME: '/codex-home' }, readFile: auth(body), now: () => NOW });

  it('reports an expired ChatGPT access token', () => {
    const body = { auth_mode: 'chatgpt', tokens: { access_token: jwt(NOW / 1000 - 3600), refresh_token: 'r' } };
    expect(codexChatgptSessionExpired(deps(body))).toBe(true);
  });

  it('accepts an access token that is still valid', () => {
    const body = { tokens: { access_token: jwt(NOW / 1000 + 3600) } };
    expect(codexChatgptSessionExpired(deps(body))).toBe(false);
  });

  it('ignores an API key login, a missing file and a malformed token', () => {
    expect(codexChatgptSessionExpired(deps({ OPENAI_API_KEY: 'k', tokens: { access_token: jwt(0) } }))).toBe(false);
    expect(codexChatgptSessionExpired({ env: { CODEX_HOME: '/x' }, readFile: noFile })).toBe(false);
    expect(codexChatgptSessionExpired(deps({ tokens: { access_token: 'not-a-jwt' } }))).toBe(false);
  });

  it('makes models --doctor evidence false for an expired session even when login status passes', () => {
    const body = { tokens: { access_token: jwt(NOW / 1000 - 60) } };
    expect(hasCodexLoginEvidence({ ...deps(body), exec: vi.fn() })).toBe(false);
  });
});
