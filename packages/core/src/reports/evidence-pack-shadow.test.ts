import { workKeyFromIssue } from '../work/work-key.js';
import { describe, expect, it } from 'vitest';

import { renderEvidencePack } from './evidence-pack.js';

describe('renderEvidencePack — shadow model verdict (#1725)', () => {
  const base = { issue: workKeyFromIssue(1), events: [], logFiles: [] };
  const shadow = {
    modelClass: 'C' as const,
    floorClass: 'A' as const,
    finalClass: 'A' as const,
    model: 'm-1',
    promptVersion: 'classify-pr/v1',
    policyVersion: 'floor-0123456789ab',
    diffSha: 'f'.repeat(64),
    adrIds: ['ADR-0121', 'ADR-0123'],
    costUsd: null,
    claims: [{ text: 'touches the gate', citation: 'src/a.ts:12' }],
    unsupportedClaims: [{ text: 'vibes', citation: '' }],
    notInspected: ['tests'],
    droppedClaims: 0,
  };

  it('renders the labeled shadow block with class, claims, gaps and ADRs', () => {
    const md = renderEvidencePack({
      ...base,
      reviewRouting: { floor: 'A', gated: false, rules: [], shadow },
    });
    expect(md).toContain('Shadow model verdict — shadow — no effect');
    expect(md).toContain('Model class: **C** (`m-1`, `classify-pr/v1`, policy `floor-0123456789ab`)');
    expect(md).toContain('Final class: A (= floor)');
    expect(md).toContain('touches the gate — `src/a.ts:12`');
    expect(md).toContain('- vibes');
    expect(md).toContain('- tests');
    expect(md).toContain('ADRs consulted: ADR-0121, ADR-0123');
  });

  it('renders the reason and "none" when the model verdict is unavailable', () => {
    const md = renderEvidencePack({
      ...base,
      reviewRouting: {
        floor: 'A',
        gated: false,
        rules: [],
        shadow: {
          ...shadow,
          modelClass: null,
          reason: 'classifier call failed: x',
          claims: [],
          unsupportedClaims: [],
          notInspected: [],
          adrIds: [],
        },
      },
    });
    expect(md).toContain('Model class: unavailable — classifier call failed: x');
    expect(md).toContain('ADRs consulted: none');
    expect(md).toContain('  - none');
  });

  it('renders no shadow block without a shadow verdict', () => {
    const md = renderEvidencePack({ ...base, reviewRouting: { floor: 'A', gated: false, rules: [] } });
    expect(md).not.toContain('Shadow model verdict');
  });
});
