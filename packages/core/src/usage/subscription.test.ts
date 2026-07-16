import { describe, expect, it, vi } from 'vitest';
import { fetchSubscriptionUsage, readClaudeAccessToken } from './subscription.js';

const validCreds = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat-fixture-token',
    refreshToken: 'sk-ant-ort-should-never-be-read',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
});

describe('readClaudeAccessToken', () => {
  it('returns the token from the keychain on darwin', async () => {
    const readKeychain = vi.fn().mockResolvedValue(validCreds);
    const readCredentialsFile = vi.fn();

    const token = await readClaudeAccessToken({ platform: 'darwin', readKeychain, readCredentialsFile });

    expect(token).toBe('sk-ant-oat-fixture-token');
    expect(readCredentialsFile).not.toHaveBeenCalled();
  });

  it('falls back to the credentials file when the keychain read throws', async () => {
    const readKeychain = vi.fn().mockRejectedValue(new Error('keychain locked'));
    const readCredentialsFile = vi.fn().mockReturnValue(validCreds);

    const token = await readClaudeAccessToken({ platform: 'darwin', readKeychain, readCredentialsFile });

    expect(token).toBe('sk-ant-oat-fixture-token');
  });

  it('skips the keychain entirely on non-darwin platforms', async () => {
    const readKeychain = vi.fn();
    const readCredentialsFile = vi.fn().mockReturnValue(validCreds);

    const token = await readClaudeAccessToken({ platform: 'linux', readKeychain, readCredentialsFile });

    expect(token).toBe('sk-ant-oat-fixture-token');
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it('returns null for an expired token without refreshing', async () => {
    const expired = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat-expired', expiresAt: Date.now() - 1000 },
    });
    const readCredentialsFile = vi.fn().mockReturnValue(expired);

    const token = await readClaudeAccessToken({ platform: 'linux', readCredentialsFile });

    expect(token).toBeNull();
  });

  it('returns null when the credentials file cannot be read', async () => {
    const readCredentialsFile = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await expect(readClaudeAccessToken({ platform: 'linux', readCredentialsFile })).resolves.toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    const readCredentialsFile = vi.fn().mockReturnValue('not json');

    await expect(readClaudeAccessToken({ platform: 'linux', readCredentialsFile })).resolves.toBeNull();
  });

  it('returns null when claudeAiOauth.accessToken is missing', async () => {
    const readCredentialsFile = vi.fn().mockReturnValue(JSON.stringify({ claudeAiOauth: {} }));

    await expect(readClaudeAccessToken({ platform: 'linux', readCredentialsFile })).resolves.toBeNull();
  });
});

describe('fetchSubscriptionUsage', () => {
  function deps(overrides: Parameters<typeof fetchSubscriptionUsage>[0] = {}) {
    return {
      platform: 'linux' as NodeJS.Platform,
      readCredentialsFile: () => validCreds,
      ...overrides,
    };
  }

  it('returns utilization and resets_at on the happy path, sending the expected headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ five_hour: { utilization: 42, resets_at: '2026-07-15T18:00:00Z' } }),
    });

    const result = await fetchSubscriptionUsage(deps({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(result).toEqual({ fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-ant-oat-fixture-token',
          'anthropic-beta': 'oauth-2025-04-20',
        }),
      }),
    );
  });

  it('returns null and never calls fetchImpl when the token is unavailable', async () => {
    const fetchImpl = vi.fn();
    const readCredentialsFile = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await fetchSubscriptionUsage(deps({ readCredentialsFile, fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null on a 401 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

    await expect(fetchSubscriptionUsage(deps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).resolves.toBeNull();
  });

  it('returns null on a 500 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(fetchSubscriptionUsage(deps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).resolves.toBeNull();
  });

  it('returns null when the body is missing five_hour.utilization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ five_hour: { resets_at: 'x' } }) });

    await expect(fetchSubscriptionUsage(deps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).resolves.toBeNull();
  });

  it('returns null when the body is malformed JSON-shaped garbage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: true }) });

    await expect(fetchSubscriptionUsage(deps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).resolves.toBeNull();
  });

  it('returns null when fetchImpl rejects (network error / timeout)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(fetchSubscriptionUsage(deps({ fetchImpl: fetchImpl as unknown as typeof fetch }))).resolves.toBeNull();
  });

  it('defaults fiveHourResetsAt to null when resets_at is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ five_hour: { utilization: 10 } }) });

    const result = await fetchSubscriptionUsage(deps({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(result).toEqual({ fiveHourUtilization: 10, fiveHourResetsAt: null });
  });
});
