import { describe, expect, it } from 'vitest';

import type { ShipResult } from '../phases/ship.js';
import { parkedPrAction } from './park-pr.js';
import { shipParkReason } from './ship-park.js';

const preview = (status: 'fail' | 'preview-unavailable' | 'pass'): ShipResult['previewCheck'] => ({
  status,
  evidence: { headSha: 'a', command: ['x'], readyWaitMs: 1, durationMs: 1, artifacts: [] },
});

describe('shipParkReason', () => {
  it('maps a preview failure to fail', () => {
    expect(shipParkReason({ ok: false, previewCheck: preview('fail') })).toBe('fail');
    expect(shipParkReason({ ok: false, previewCheck: preview('preview-unavailable') })).toBe('fail');
  });

  it('keeps the denial and CI mappings', () => {
    expect(shipParkReason({ ok: false, denied: true, previewCheck: preview('fail') })).toBe('escalate');
    expect(shipParkReason({ ok: false, ciOutcome: 'failure' })).toBe('ci-failed');
    expect(shipParkReason({ ok: false, ciOutcome: 'infra-failure' })).toBe('ci-infra');
    expect(shipParkReason({ ok: false })).toBe('fail');
  });

  it('parks a SHIP that failed on unknown CI as fail, which closes its draft PR instead of readying it', () => {
    const ciUnknown: ShipResult = { ok: false, prNumber: 123, ciPending: true, draft: true };
    expect(shipParkReason(ciUnknown)).toBe('fail');
    expect(parkedPrAction(shipParkReason(ciUnknown), false)).toBe('close');
  });
});
