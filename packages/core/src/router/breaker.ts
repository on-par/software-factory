// src/router/breaker.ts — Supervisor provider circuit breaker: file-backed
// cooldown state so a quota-tripped provider is skipped by subsequent lanes
// until the cooldown expires (#369).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { FailoverReason } from '../types/index.js';

export interface BreakerEntry {
  reason: FailoverReason;
  openedAt: string;
  cooldownMs: number;
}

export type BreakerStatus =
  { open: true; entry: BreakerEntry; remainingMs: number } | { open: false; justClosed?: BreakerEntry };

interface BreakerFile {
  version: 1;
  providers: Record<string, BreakerEntry>;
}

export class ProviderBreaker {
  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
  ) {}

  /** Upsert (refresh openedAt on repeat trips). Atomic write: mkdir parent, write `${file}.tmp`, rename. */
  async open(provider: string, reason: FailoverReason, cooldownMs: number): Promise<void> {
    const data = await this.read();
    data.providers[provider] = { reason, openedAt: new Date(this.now()).toISOString(), cooldownMs };
    await this.write(data);
  }

  /** Reads the file. If the entry's openedAt + cooldownMs <= now(), prune it
   *  (rewrite the file without it) and return { open: false, justClosed: entry }
   *  so the caller can emit provider_breaker_close exactly once per observer.
   *  Missing/corrupt/unparsable file => { open: false }. */
  async status(provider: string): Promise<BreakerStatus> {
    const data = await this.read();
    const entry = data.providers[provider];
    if (!entry) return { open: false };

    const remainingMs = new Date(entry.openedAt).getTime() + entry.cooldownMs - this.now();
    if (remainingMs > 0) return { open: true, entry, remainingMs };

    delete data.providers[provider];
    await this.write(data);
    return { open: false, justClosed: entry };
  }

  /** Read-only (never rewrites the file — factory status must not mutate state).
   *  Returns only still-open entries with computed remainingMs. */
  async list(): Promise<Array<{ provider: string; reason: FailoverReason; openedAt: string; remainingMs: number }>> {
    const data = await this.read();
    const out: Array<{ provider: string; reason: FailoverReason; openedAt: string; remainingMs: number }> = [];
    for (const [provider, entry] of Object.entries(data.providers)) {
      const remainingMs = new Date(entry.openedAt).getTime() + entry.cooldownMs - this.now();
      if (remainingMs > 0) {
        out.push({ provider, reason: entry.reason, openedAt: entry.openedAt, remainingMs });
      }
    }
    return out;
  }

  private async read(): Promise<BreakerFile> {
    try {
      const raw = await readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<BreakerFile>;
      return { version: 1, providers: parsed.providers ?? {} };
    } catch {
      return { version: 1, providers: {} };
    }
  }

  private async write(data: BreakerFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    // Two lanes racing on expiry may both prune-and-rewrite (or both open) —
    // benign, at most a duplicate provider_breaker_close/open event; no lock file.
    await rename(tmp, this.file);
  }
}

/** Pre-BUILD gate used by the CLI lane runner. For each provider:
 *  - open  => log('provider_breaker_skip', ...) and return codexBlocked: true
 *  - justClosed => log('provider_breaker_close', ...)
 *  Round minutes with Math.ceil(remainingMs / 60000). */
export async function gateBuildOnBreaker(opts: {
  breaker: ProviderBreaker;
  providers: string[];
  log: (type: string, msg: string) => void;
}): Promise<{ codexBlocked: boolean }> {
  const { breaker, providers, log } = opts;
  let codexBlocked = false;

  for (const provider of providers) {
    const status = await breaker.status(provider);
    if (status.open) {
      codexBlocked = true;
      const m = Math.ceil(status.remainingMs / 60_000);
      log(
        'provider_breaker_skip',
        `breaker open for ${provider} (${status.entry.reason}) — routing build to claude fallback, ${m}m remaining`,
      );
    } else if (status.justClosed) {
      log('provider_breaker_close', `breaker closed for ${provider} after cooldown — codex workers eligible again`);
    }
  }

  return { codexBlocked };
}
