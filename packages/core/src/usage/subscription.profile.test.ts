// Covers the default keychain/credentials-file readers (run with an injected exec, no
// injected readers), which resolve the Claude profile selected by CLAUDE_CONFIG_DIR.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readClaudeAccessToken, type SubscriptionUsageDeps } from './subscription.js';

function creds(accessToken: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt: Date.now() + 60 * 60 * 1000 } });
}

describe('readClaudeAccessToken default readers', () => {
  let profileDir: string;
  let execMock: ReturnType<typeof vi.fn<NonNullable<SubscriptionUsageDeps['exec']>>>;

  beforeEach(() => {
    execMock = vi.fn<NonNullable<SubscriptionUsageDeps['exec']>>();
    profileDir = mkdtempSync(join(tmpdir(), 'factory-claude-profile-'));
  });

  afterEach(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("reads the default 'Claude Code-credentials' keychain entry when CLAUDE_CONFIG_DIR is unset", async () => {
    execMock.mockResolvedValue({ stdout: creds('sk-ant-oat-default') });

    const token = await readClaudeAccessToken({ platform: 'darwin', env: {}, exec: execMock });

    expect(token).toBe('sk-ant-oat-default');
    expect(execMock).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 10_000 },
    );
  });

  it("reads the selected profile's hash-suffixed keychain entry when CLAUDE_CONFIG_DIR is set", async () => {
    execMock.mockResolvedValue({ stdout: creds('sk-ant-oat-work') });

    const token = await readClaudeAccessToken({
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' },
      exec: execMock,
    });

    expect(token).toBe('sk-ant-oat-work');
    expect(execMock).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials-685abfe8', '-w'],
      { timeout: 10_000 },
    );
  });

  it("falls back to $CLAUDE_CONFIG_DIR/.credentials.json when the profile's keychain entry is missing", async () => {
    execMock.mockRejectedValue(new Error('The specified item could not be found in the keychain.'));
    writeFileSync(join(profileDir, '.credentials.json'), creds('sk-ant-oat-from-profile-file'));

    const token = await readClaudeAccessToken({
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: profileDir },
      exec: execMock,
    });

    expect(token).toBe('sk-ant-oat-from-profile-file');
  });

  it('reads $CLAUDE_CONFIG_DIR/.credentials.json on non-darwin platforms without touching the keychain', async () => {
    writeFileSync(join(profileDir, '.credentials.json'), creds('sk-ant-oat-linux-profile'));

    const token = await readClaudeAccessToken({
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: profileDir },
      exec: execMock,
    });

    expect(token).toBe('sk-ant-oat-linux-profile');
    expect(execMock).not.toHaveBeenCalled();
  });

  it("returns null when the selected profile has no credentials file (never reads another profile's)", async () => {
    const token = await readClaudeAccessToken({
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: profileDir },
      exec: execMock,
    });

    expect(token).toBeNull();
  });
});
