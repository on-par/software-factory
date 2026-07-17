// src/usage/subscription.ts — real Claude subscription usage (OAuth /usage endpoint)
//
// Reads the same 5-hour rate-limit window Claude Code's own /usage UI shows,
// using the OAuth access token already stored on the machine. Never reads or
// uses the refresh token, never refreshes, never logs/throws the token.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { execa } from 'execa';
import { z } from 'zod';

export interface SubscriptionUsage {
  fiveHourUtilization: number;
  fiveHourResetsAt: string | null;
}

export interface SubscriptionUsageDeps {
  platform?: NodeJS.Platform;
  readKeychain?: () => Promise<string>;
  readCredentialsFile?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_CREDENTIALS_PATH = resolve(homedir(), '.claude/.credentials.json');

async function defaultReadKeychain(): Promise<string> {
  const result = await execa('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
    timeout: 10_000,
  });
  return result.stdout;
}

function defaultReadCredentialsFile(): string {
  return readFileSync(DEFAULT_CREDENTIALS_PATH, 'utf-8');
}

const UsageResponseSchema = z
  .object({
    five_hour: z.object({
      utilization: z.number(),
      resets_at: z.string().nullish(),
    }),
  })
  .passthrough();

export async function readClaudeAccessToken(deps: SubscriptionUsageDeps = {}): Promise<string | null> {
  const {
    platform = process.platform,
    readKeychain = defaultReadKeychain,
    readCredentialsFile = defaultReadCredentialsFile,
    now = Date.now,
  } = deps;

  let raw: string | null = null;

  if (platform === 'darwin') {
    try {
      const keychainRaw = await readKeychain();
      if (keychainRaw.trim().length > 0) raw = keychainRaw;
    } catch {
      raw = null;
    }
  }

  if (raw === null) {
    try {
      raw = readCredentialsFile();
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(raw);
    const accessToken = parsed?.claudeAiOauth?.accessToken;
    const expiresAt = parsed?.claudeAiOauth?.expiresAt;

    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now()) return null;

    return accessToken;
  } catch {
    return null;
  }
}

export async function fetchSubscriptionUsage(deps: SubscriptionUsageDeps = {}): Promise<SubscriptionUsage | null> {
  const { fetchImpl = globalThis.fetch } = deps;

  try {
    const token = await readClaudeAccessToken(deps);
    if (token === null) return null;

    const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const body = await response.json();
    const parsed = UsageResponseSchema.safeParse(body);
    if (!parsed.success) return null;

    return {
      fiveHourUtilization: parsed.data.five_hour.utilization,
      fiveHourResetsAt: parsed.data.five_hour.resets_at ?? null,
    };
  } catch {
    return null;
  }
}
