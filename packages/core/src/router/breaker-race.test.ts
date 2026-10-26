import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderOrder } from '../config/provider-order.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { pickOrderedProvider } from '../run/provider-breaker-gate.js';

import { ProviderBreaker } from './breaker.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

const tmpFile = async () => join(await tempDirs.make('breaker-race-test-'), 'breaker.json');

describe('restore probe claim races another lane (#3708)', () => {
  const CAPPED_UNTIL = '2026-10-20T12:00:00.000Z'; // 07:00 CT
  const T_0705 = Date.parse('2026-10-20T12:05:00Z');

  it("a lane whose read raced another lane's finished probe does not claim or probe again", async () => {
    const file = await tmpFile();
    let t = T_0705 - 35 * 60_000;
    await new ProviderBreaker(file, () => t).open('anthropic', 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
    t = T_0705;
    let armed = false;
    const racing = () =>
      new ProviderBreaker(file, () => {
        if (armed) {
          armed = false;
          // lane C's finished probe: closeAfterProbe dropped the entry and its claim
          writeFileSync(file, JSON.stringify({ version: 1, providers: {} }));
        }
        return t;
      });
    const claimFile = `${file}.probe-anthropic-${Date.parse(CAPPED_UNTIL)}`;

    const d = racing();
    armed = true;
    expect(await d.claimProbe('anthropic')).toBe('not-due');
    expect(existsSync(claimFile)).toBe(false);

    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: {
            reason: 'usage_cap',
            openedAt: T_0705 - 35 * 60_000,
            cooldownMs: 30 * 60_000,
            cappedUntil: CAPPED_UNTIL,
          },
        },
      }),
    );
    const probe = vi.fn(async () => {});
    const registryRef = { get: () => ({ provider: 'anthropic', harness: 'claude-cli' }) } as never;
    const order: ProviderOrder = { boss: [], worker: ['claude-w'], checker: [], triage: [] };
    const gated = racing();
    armed = true;
    await pickOrderedProvider({ router: { registryRef }, breaker: gated, probe }, order, 'build', new Set());
    expect(probe).not.toHaveBeenCalled();
    expect(existsSync(claimFile)).toBe(false);
  });

  it('a lane whose read raced another lane re-capping the provider does not claim', async () => {
    const file = await tmpFile();
    let t = T_0705 - 35 * 60_000;
    await new ProviderBreaker(file, () => t).open('anthropic', 'usage_cap', 30 * 60_000, { cappedUntil: CAPPED_UNTIL });
    t = T_0705;
    let armed = true;
    const d = new ProviderBreaker(file, () => {
      if (armed) {
        armed = false;
        writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            providers: {
              anthropic: {
                reason: 'usage_cap',
                openedAt: T_0705,
                cooldownMs: 60 * 60_000,
                cappedUntil: new Date(T_0705 + 60 * 60_000).toISOString(),
              },
            },
          }),
        );
      }
      return t;
    });
    expect(await d.claimProbe('anthropic')).toBe('not-due');
    expect(existsSync(`${file}.probe-anthropic-${Date.parse(CAPPED_UNTIL)}`)).toBe(false);
  });
});
