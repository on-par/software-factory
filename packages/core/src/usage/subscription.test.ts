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

// Reported shape of /api/oauth/usage; replace with a captured real response before merge.
const WEEKLY_USAGE_FIXTURE = {
  five_hour: { utilization: 20, resets_at: '2026-10-19T03:00:00Z' },
  seven_day: { utilization: 96, resets_at: '2026-10-20T12:00:00Z' },
};

function recordingCredentialsFile() {
  const reads: string[] = [];
  const readCredentialsFile = () => {
    reads.push('read');
    return validCreds;
  };
  return { reads, readCredentialsFile };
}

describe('readClaudeAccessToken', () => {
  it('prefers an injected readKeychain over an injected exec', async () => {
    const readKeychain = vi.fn().mockResolvedValue(validCreds);
    const execCalls: string[] = [];
    const exec = async (file: string) => {
      execCalls.push(file);
      return { stdout: '' };
    };

    const token = await readClaudeAccessToken({ platform: 'darwin', readKeychain, exec });

    expect(token).toBe('sk-ant-oat-fixture-token');
    expect(execCalls).toEqual([]);
  });

  it('returns the token from the keychain on darwin', async () => {
    const readKeychain = vi.fn().mockResolvedValue(validCreds);
    const { reads, readCredentialsFile } = recordingCredentialsFile();

    const token = await readClaudeAccessToken({ platform: 'darwin', readKeychain, readCredentialsFile });

    expect(token).toBe('sk-ant-oat-fixture-token');
    expect(reads).toEqual([]);
  });

  it('falls back to the credentials file when the keychain read throws', async () => {
    const readKeychain = vi.fn().mockRejectedValue(new Error('keychain locked'));
    const readCredentialsFile = vi.fn().mockReturnValue(validCreds);

    const token = await readClaudeAccessToken({ platform: 'darwin', readKeychain, readCredentialsFile });

    expect(token).toBe('sk-ant-oat-fixture-token');
  });

  it('falls back to the credentials file when the keychain resolves to an empty string', async () => {
    const readKeychain = vi.fn().mockResolvedValue('');
    const { reads, readCredentialsFile } = recordingCredentialsFile();

    const token = await readClaudeAccessToken({ platform: 'darwin', readKeychain, readCredentialsFile });

    expect(token).toBe('sk-ant-oat-fixture-token');
    expect(reads).toHaveLength(1);
  });

  it('skips the keychain entirely on non-darwin platforms', async () => {
    const keychainReads: string[] = [];
    const readKeychain = async () => {
      keychainReads.push('read');
      return '';
    };
    const readCredentialsFile = vi.fn().mockReturnValue(validCreds);

    const token = await readClaudeAccessToken({ platform: 'linux', readKeychain, readCredentialsFile });

    expect(token).toBe('sk-ant-oat-fixture-token');
    expect(keychainReads).toEqual([]);
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
    const requests: Array<[unknown, RequestInit | undefined]> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push([url, init]);
      return Response.json({ five_hour: { utilization: 42, resets_at: '2026-07-15T18:00:00Z' } });
    };

    const result = await fetchSubscriptionUsage(deps({ fetchImpl }));

    expect(result).toEqual({
      fiveHourUtilization: 42,
      fiveHourResetsAt: '2026-07-15T18:00:00Z',
      sevenDayUtilization: null,
      sevenDayResetsAt: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.[0]).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(requests[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer sk-ant-oat-fixture-token',
      'anthropic-beta': 'oauth-2025-04-20',
    });
  });

  it('returns null and never calls fetchImpl when the token is unavailable', async () => {
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      requests.push(url);
      return new Response(null, { status: 500 });
    };
    const readCredentialsFile = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await fetchSubscriptionUsage(deps({ readCredentialsFile, fetchImpl }));

    expect(result).toBeNull();
    expect(requests).toEqual([]);
  });

  it('returns null on a 401 response', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(fetchSubscriptionUsage(deps({ fetchImpl }))).resolves.toBeNull();
  });

  it('returns null on a 500 response', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(new Response(null, { status: 500 }));

    await expect(fetchSubscriptionUsage(deps({ fetchImpl }))).resolves.toBeNull();
  });

  it('returns null when the body is missing five_hour.utilization', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(Response.json({ five_hour: { resets_at: 'x' } }));

    await expect(fetchSubscriptionUsage(deps({ fetchImpl }))).resolves.toBeNull();
  });

  it('returns null when the body is malformed JSON-shaped garbage', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(Response.json({ nope: true }));

    await expect(fetchSubscriptionUsage(deps({ fetchImpl }))).resolves.toBeNull();
  });

  it('returns null when fetchImpl rejects (network error / timeout)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockRejectedValue(new Error('network down'));

    await expect(fetchSubscriptionUsage(deps({ fetchImpl }))).resolves.toBeNull();
  });

  it('defaults fiveHourResetsAt to null when resets_at is absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(Response.json({ five_hour: { utilization: 10 } }));

    const result = await fetchSubscriptionUsage(deps({ fetchImpl }));

    expect(result).toEqual({
      fiveHourUtilization: 10,
      fiveHourResetsAt: null,
      sevenDayUtilization: null,
      sevenDayResetsAt: null,
    });
  });

  it('returns null weekly fields when seven_day is absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(Response.json({ five_hour: { utilization: 5 } }));

    const result = await fetchSubscriptionUsage(deps({ fetchImpl }));

    expect(result?.sevenDayUtilization).toBeNull();
    expect(result?.sevenDayResetsAt).toBeNull();
  });

  it('parses an optional seven_day window into sevenDayUtilization and sevenDayResetsAt', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(Response.json(WEEKLY_USAGE_FIXTURE));

    const result = await fetchSubscriptionUsage(deps({ fetchImpl }));

    expect(result).toEqual({
      fiveHourUtilization: 20,
      fiveHourResetsAt: '2026-10-19T03:00:00Z',
      sevenDayUtilization: 96,
      sevenDayResetsAt: '2026-10-20T12:00:00Z',
    });
  });

  it.each([{ seven_day: null }, { seven_day: { utilization: '96' } }, { seven_day: 'x' }])(
    'degrades a malformed or null seven_day to null weekly fields without failing the reading (%j)',
    async (extra) => {
      const fetchImpl = vi.fn<typeof fetch>();
      fetchImpl.mockResolvedValue(Response.json({ five_hour: { utilization: 20 }, ...extra }));

      const result = await fetchSubscriptionUsage(deps({ fetchImpl }));

      expect(result).toEqual({
        fiveHourUtilization: 20,
        fiveHourResetsAt: null,
        sevenDayUtilization: null,
        sevenDayResetsAt: null,
      });
    },
  );

  it('defaults sevenDayResetsAt to null when seven_day.resets_at is absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(Response.json({ five_hour: { utilization: 20 }, seven_day: { utilization: 70 } }));

    const result = await fetchSubscriptionUsage(deps({ fetchImpl }));

    expect(result?.sevenDayUtilization).toBe(70);
    expect(result?.sevenDayResetsAt).toBeNull();
  });
});
