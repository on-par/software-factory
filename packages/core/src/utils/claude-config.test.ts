import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeConfigDirOverride, claudeConfigDirPath, claudeKeychainService } from './claude-config.js';

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
