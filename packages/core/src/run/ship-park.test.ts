import { describe, expect, it } from 'vitest';

import type { ShipResult } from '../phases/ship.js';
import { shipParkReason } from './ship-park.js';

const preview = (status: 'fail' | 'preview-unavailable' | 'pass'): ShipResult['previewCheck'] => ({
  status,
  evidence: { headSha: 'a', command: ['x'], durationMs: 1, artifacts: [] },
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
});
