import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Redirect homedir() so the default estimateTrailingSpend() scan is hermetic.
// Keep every other node:os export (tmpdir!) real.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => mockedHome };
});

// Stub the subscription signal so no test hits the keychain or network.
vi.mock('./subscription.js', () => ({
  fetchSubscriptionUsage: vi.fn(async () => null),
}));

import type { logEvent } from '../utils/index.js';
import { readUsage, watchUsage } from './index.js';
import { fetchSubscriptionUsage } from './subscription.js';

type EmitEventArgs = Parameters<typeof logEvent>;

// usage/index.ts only calls homedir() lazily, inside defaultTranscriptRoots()
// at call time, so it's safe to assign this after the mocked imports above.
const mockedHome = mkdtempSync(join(tmpdir(), 'factory-usage-home-'));
const tempDirs: string[] = [mockedHome];

function mkdtemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-usage-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.mocked(fetchSubscriptionUsage).mockReset();
  for (const dir of tempDirs.splice(1)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readUsage defaults', () => {
  it('falls back to the default estimator over the default transcript roots', async () => {
    vi.mocked(fetchSubscriptionUsage).mockResolvedValueOnce(null);
    const transcript = join(mockedHome, '.claude/projects/p/session.jsonl');
    mkdirSync(join(mockedHome, '.claude/projects/p'), { recursive: true });
    writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 1_000_000 } },
      }) + '\n',
    );

    const reading = await readUsage({ cap: 227, estimator: true });

    expect(reading).toEqual({ pct: 3 / 227, source: 'estimate', detail: 'trailing-5h usage ~= $3 = 1% of $227 cap' });
  });

  it('default fetchSubscription wires to fetchSubscriptionUsage', async () => {
    vi.mocked(fetchSubscriptionUsage).mockResolvedValueOnce({ fiveHourUtilization: 42, fiveHourResetsAt: null });

    const reading = await readUsage({ cap: 227, estimator: false });

    expect(reading).toEqual({ pct: 0.42, source: 'subscription', detail: '5h subscription window at 42%' });
    expect(fetchSubscriptionUsage).toHaveBeenCalledOnce();
  });
});

describe('watchUsage defaults', () => {
  it('uses the default readUsageFn and default setStop', async () => {
    vi.mocked(fetchSubscriptionUsage).mockResolvedValueOnce({ fiveHourUtilization: 100, fiveHourResetsAt: null });
    const dir = mkdtemp();
    const stopFile = join(dir, 'STOP');
    const events: EmitEventArgs[] = [];

    const result = await watchUsage({
      cap: 227,
      stopAt: 0.75,
      pollMs: 180_000,
      stopFile,
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
