import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  claudeConfigDirOverride,
  claudeConfigDirPath,
  claudeKeychainService,
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
    expect(hasClaudeLoginEvidence({ env: {}, platform: 'darwin', exec, fileExists: () => true })).toBe(true);
    expect(hasClaudeLoginEvidence({ env: {}, platform: 'darwin', exec, fileExists: () => false })).toBe(false);
  });

  it('never calls exec on linux; only the credentials file decides', () => {
    const exec = vi.fn();
    expect(hasClaudeLoginEvidence({ env: {}, platform: 'linux', exec, fileExists: () => true })).toBe(true);
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
