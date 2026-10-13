import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  claudeConfigDirOverride,
  claudeConfigDirPath,
  claudeKeychainService,
  claudeStoredSessionState,
  hasClaudeLoginEvidence,
} from './claude-config.js';

describe('claudeConfigDirOverride', () => {
  it('is undefined when CLAUDE_CONFIG_DIR is unset or empty', () => {
    expect(claudeConfigDirOverride({})).toBeUndefined();
    expect(claudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '' })).toBeUndefined();
  });

  it('returns CLAUDE_CONFIG_DIR verbatim when set', () => {
    expect(claudeConfigDirOverride({ CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' })).toBe('/home/dev/.claude-work');
  });

  it('NFC-normalizes the value, as Claude Code does', () => {
    const decomposed = '/home/dev/.claude-café';
    expect(claudeConfigDirOverride({ CLAUDE_CONFIG_DIR: decomposed })).toBe('/home/dev/.claude-café');
  });
});

describe('claudeConfigDirPath', () => {
  it('defaults to ~/.claude under the given home when CLAUDE_CONFIG_DIR is unset', () => {
    expect(claudeConfigDirPath({}, '/home/dev')).toBe('/home/dev/.claude');
  });

  it('uses CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeConfigDirPath({ CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' }, '/home/dev')).toBe(
      '/home/dev/.claude-work',
    );
  });

  it('resolves a relative CLAUDE_CONFIG_DIR to an absolute path', () => {
    expect(claudeConfigDirPath({ CLAUDE_CONFIG_DIR: 'rel-profile' }, '/home/dev')).toBe(resolve('rel-profile'));
  });
});

describe('claudeKeychainService', () => {
  it("is the default 'Claude Code-credentials' when CLAUDE_CONFIG_DIR is unset or empty", () => {
    expect(claudeKeychainService({})).toBe('Claude Code-credentials');
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: '' })).toBe('Claude Code-credentials');
  });

  it('suffixes the first 8 hex of sha256(CLAUDE_CONFIG_DIR) for a non-default profile', () => {
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' })).toBe(
      'Claude Code-credentials-685abfe8',
    );
  });

  it('hashes the dir as spelled, so a trailing slash names a different entry (Claude Code parity)', () => {
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: '/home/dev/.claude-work/' })).not.toBe(
      'Claude Code-credentials-685abfe8',
    );
  });

  it('CLAUDE_SECURESTORAGE_CONFIG_DIR overrides which dir is hashed', () => {
    expect(
      claudeKeychainService({
        CLAUDE_CONFIG_DIR: '/home/dev/.claude-work',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/dev/secure',
      }),
    ).toBe('Claude Code-credentials-b17f30f3');
    expect(claudeKeychainService({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/dev/secure' })).toBe(
      'Claude Code-credentials-b17f30f3',
    );
  });

  it('an empty CLAUDE_SECURESTORAGE_CONFIG_DIR pins the default entry even with a profile set', () => {
    expect(
      claudeKeychainService({ CLAUDE_CONFIG_DIR: '/home/dev/.claude-work', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }),
    ).toBe('Claude Code-credentials');
  });
});

const noFile = (): string => {
  throw new Error('ENOENT');
};

describe('hasClaudeLoginEvidence', () => {
  it('returns true for a non-empty CLAUDE_CODE_OAUTH_TOKEN without touching exec or the filesystem', () => {
    const exec = vi.fn();
    const fileExists = vi.fn(() => false);
    expect(
      hasClaudeLoginEvidence({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, platform: 'darwin', exec, fileExists }),
    ).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(fileExists).not.toHaveBeenCalled();
  });

  it('ignores a whitespace-only CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(
      hasClaudeLoginEvidence({
        env: { CLAUDE_CODE_OAUTH_TOKEN: '  ' },
        platform: 'linux',
        fileExists: () => false,
      }),
    ).toBe(false);
  });

  it('uses only env, keychain-entry and file-existence evidence and never runs claude', () => {
    const exec = vi.fn();
    expect(hasClaudeLoginEvidence({ env: {}, platform: 'darwin', exec, fileExists: () => false })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('security', ['find-generic-password', '-s', 'Claude Code-credentials']);
    expect(exec.mock.calls[0]![1]).not.toContain('-w');
    expect(exec.mock.calls.some(([file]) => file === 'claude')).toBe(false);
  });

  it('resolves the keychain service and credentials file for CLAUDE_CONFIG_DIR', () => {
    const env = { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' };
    const exec = vi.fn(() => {
      throw new Error('not found');
    });
    const fileExists = vi.fn(() => true);
    expect(hasClaudeLoginEvidence({ env, platform: 'darwin', exec, fileExists })).toBe(true);
    expect(exec).toHaveBeenCalledWith('security', ['find-generic-password', '-s', claudeKeychainService(env)]);
    expect(fileExists).toHaveBeenCalledWith(resolve('/home/dev/.claude-work', '.credentials.json'));
  });

  it('falls back to the credentials file when the darwin keychain lookup throws', () => {
    const exec = vi.fn(() => {
      throw new Error('no keychain');
    });
    expect(
      hasClaudeLoginEvidence({ env: {}, platform: 'darwin', exec, fileExists: () => true, readFile: noFile }),
    ).toBe(true);
    expect(hasClaudeLoginEvidence({ env: {}, platform: 'darwin', exec, fileExists: () => false })).toBe(false);
  });

  it('never calls exec on linux; only the credentials file decides', () => {
    const exec = vi.fn();
    expect(hasClaudeLoginEvidence({ env: {}, platform: 'linux', exec, fileExists: () => true, readFile: noFile })).toBe(
      true,
    );
    expect(hasClaudeLoginEvidence({ env: {}, platform: 'linux', exec, fileExists: () => false })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns false when the file check throws', () => {
    expect(
      hasClaudeLoginEvidence({
        env: {},
        platform: 'linux',
        fileExists: () => {
          throw new Error('EACCES');
        },
      }),
    ).toBe(false);
  });

  it('runs with real defaults without throwing', () => {
    expect(typeof hasClaudeLoginEvidence({ env: { CLAUDE_CONFIG_DIR: '/nonexistent/x' }, platform: 'linux' })).toBe(
      'boolean',
    );
  });
});

describe('claudeStoredSessionState (#2721)', () => {
  const NOW = 1_800_000_000_000;
  const env = { CLAUDE_CONFIG_DIR: '/p' };
  const file = (oauth: unknown) => () => JSON.stringify({ claudeAiOauth: oauth });
  const state = (readFile: (p: string) => string) => claudeStoredSessionState({ env, readFile, now: () => NOW });

  it('is ok while the access token is live', () => {
    expect(state(file({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3_600_000 }))).toBe('ok');
  });

  it('is refresh-pending when the access token expired but a refresh token is present (idle login stays signed in)', () => {
    expect(state(file({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW - 1 }))).toBe('refresh-pending');
    expect(state(file({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 60_000 }))).toBe('refresh-pending');
  });

  it('is unusable when the access token expired and there is no refresh token', () => {
    expect(state(file({ accessToken: 'a', expiresAt: NOW - 1 }))).toBe('unusable');
    expect(state(file({ accessToken: 'a', refreshToken: '  ', expiresAt: NOW - 1 }))).toBe('unusable');
    expect(state(file({ refreshToken: '' }))).toBe('unusable');
  });

  it('is unusable for unparseable or shapeless files', () => {
    expect(state(() => '{not json')).toBe('unusable');
    expect(state(() => 'null')).toBe('unusable');
  });

  it('is unknown with no file or no expiry to judge', () => {
    expect(
      state(() => {
        throw new Error('ENOENT');
      }),
    ).toBe('unknown');
    expect(state(file({ accessToken: 'a' }))).toBe('unknown');
    expect(state(() => '{}')).toBe('unknown');
  });

  it('reads the selected profile file', () => {
    const readFile = vi.fn(file({ accessToken: 'a', expiresAt: NOW + 3_600_000 }));
    state(readFile);
    expect(readFile).toHaveBeenCalledWith(resolve('/p', '.credentials.json'));
  });

  it('runs with real defaults without throwing', () => {
    expect(['ok', 'refresh-pending', 'unusable', 'unknown']).toContain(claudeStoredSessionState({ env }));
  });
});

describe('hasClaudeLoginEvidence with an expired stored login (#2721)', () => {
  const NOW = 1_800_000_000_000;
  const base = { env: { CLAUDE_CONFIG_DIR: '/p' }, platform: 'linux' as const, fileExists: () => true, now: () => NOW };

  it('is false when the access token expired and no refresh token can renew it', () => {
    const readFile = () => JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: NOW - 1 } });
    expect(hasClaudeLoginEvidence({ ...base, readFile })).toBe(false);
  });

  it('stays true for an expired access token with a refresh token', () => {
    const readFile = () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: NOW - 1 } });
    expect(hasClaudeLoginEvidence({ ...base, readFile })).toBe(true);
  });

  it('a CLAUDE_CODE_OAUTH_TOKEN still wins without reading the file', () => {
    const readFile = vi.fn(() => '{}');
    expect(hasClaudeLoginEvidence({ ...base, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, readFile })).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });
});
