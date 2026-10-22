// packages/core/src/queue/claim-settle.ts — the claim settle delay and its injectable sleep (#3239, used by #3145).

import { defaultFactoryConfig } from '@on-par/factory-config';

import type { FactoryConfig } from '../config/index.js';

/** Default wait between writing a claim and confirming it (#3239, used by #3145). */
export const DEFAULT_CLAIM_SETTLE_MS = 3000;

export interface ClaimSettleOptions {
  /** Wait between writing a claim and confirming it (#3145). Defaults to `DEFAULT_CLAIM_SETTLE_MS`. */
  claimSettleMs?: number;
  /** Sleep injection for tests. Defaults to a `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ClaimSettler {
  /** The resolved claim settle delay in ms (#3239). */
  readonly claimSettleMs: number;
  /** Waits `claimSettleMs` through the injected sleep. Not called by any claim path yet (#3145 adds that). */
  settle(): Promise<void>;
}

export function createClaimSettler(options: ClaimSettleOptions): ClaimSettler {
  const claimSettleMs = options.claimSettleMs ?? DEFAULT_CLAIM_SETTLE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    claimSettleMs,
    async settle(): Promise<void> {
      await sleep(claimSettleMs);
    },
  };
}

/** Claim settle delay in ms for the GitHub queue's claim confirmation, from validated config (#3239). */
export function resolveQueueClaimSettleMs(config: FactoryConfig): number {
  return config.queue?.claim_settle_ms ?? defaultFactoryConfig.queue.claim_settle_ms;
}
