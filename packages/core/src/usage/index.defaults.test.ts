import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { logEvent } from '../utils/index.js';
import { readUsage, watchUsage } from './index.js';
import type { SubscriptionUsageDeps } from './subscription.js';

type EmitEventArgs = Parameters<typeof logEvent>;

const creds = JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-ant-oat-test', expiresAt: Date.now() + 3_600_000 },
});

const tempDirs: string[] = [];
let home: string;

function mkdtemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-usage-'));
  tempDirs.push(dir);
  return dir;
}

/** Fake subscription deps: null utilization means no token (fetch is never called). */
function subscriptionDeps(utilization: number | null, fetchImpl = vi.fn<typeof fetch>()): SubscriptionUsageDeps {
  if (utilization !== null) {
    fetchImpl.mockResolvedValue(Response.json({ five_hour: { utilization, resets_at: null } }));
  }
  return {
    platform: 'linux',
    env: {},
    readCredentialsFile: () => {
      if (utilization === null) throw new Error('no credentials');
      return creds;
    },
    fetchImpl,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'factory-usage-home-'));
  tempDirs.push(home);
  // Empty means "default profile", so the estimator uses `home` even if the shell sets CLAUDE_CONFIG_DIR.
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readUsage defaults', () => {
  it('falls back to the default estimator over the default transcript roots', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const transcript = join(home, '.claude/projects/p/session.jsonl');
    mkdirSync(join(home, '.claude/projects/p'), { recursive: true });
    writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000 } },
      }) + '\n',
    );

    const reading = await readUsage({
      cap: 227,
      estimator: true,
      subscription: subscriptionDeps(null, fetchImpl),
      home,
    });

    expect(reading).toEqual({ pct: 3 / 227, source: 'estimate', detail: 'trailing-5h usage ~= $3 = 1% of $227 cap' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('default fetchSubscription wires to fetchSubscriptionUsage', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const reading = await readUsage({
      cap: 227,
      estimator: false,
      subscription: subscriptionDeps(42, fetchImpl),
      home,
    });

    expect(reading).toEqual({ pct: 0.42, source: 'subscription', detail: '5h subscription window at 42%' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-ant-oat-test' }) }),
    );
  });
});

describe('watchUsage defaults', () => {
  it('uses the default readUsageFn and default setStop', async () => {
    const dir = mkdtemp();
    const stopFile = join(dir, 'STOP');
    const events: EmitEventArgs[] = [];

    const result = await watchUsage({
      cap: 227,
      stopAt: 0.75,
      pollMs: 180_000,
      stopFile,
      subscription: subscriptionDeps(100),
      home,
      eventsFile: join(dir, 'events.ndjson'),
      emitEvent: (...args) => {
        events.push(args);
      },
      sleep: async () => {},
    });

    expect(result).toBe('stopped');
    expect(existsSync(stopFile)).toBe(true);
    const stopEvent = events.find(([, type]) => type === 'usage-stop');
    expect(stopEvent?.[3]).toContain('5h subscription window at 100%');
  });
});
