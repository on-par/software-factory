import { T2_AUTO_RECEIPT, type ReviewRouting } from '../review/routing.js';
import type { RunLogFn } from './attribution.js';

/** Log the trust-tier facts of a decided routing (#1960): the demotion warning before the gate, the `t2-auto` receipt after it. */
export function logTrustTier(routing: ReviewRouting, stage: 'demotion' | 'receipt', log: RunLogFn): void {
  const { trustTier, receipt } = routing;
  if (stage === 'demotion' && trustTier?.demotion !== undefined)
    log('warn', `trust tier ${trustTier.configured} demoted to ${trustTier.effective}: ${trustTier.demotion}`);
  if (stage === 'receipt' && receipt === T2_AUTO_RECEIPT)
    log(
      'land',
      `${T2_AUTO_RECEIPT}: class A floor at trust tier T2 — eligible for auto-merge after required CI, no human click`,
    );
}
