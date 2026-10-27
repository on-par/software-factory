import { describe, expect, it } from 'vitest';

import type { ReviewRouting } from '../review/routing.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { renderEvidencePack } from './evidence-pack.js';

describe('renderEvidencePack — T2 receipt (#1960)', () => {
  const base = { issue: workKeyFromIssue(1), events: [], logFiles: [] };
  const routing = (extra: Partial<ReviewRouting>): ReviewRouting => ({ floor: 'A', gated: false, rules: [], ...extra });

  it('renders the t2-auto receipt and the trust tier', () => {
    const md = renderEvidencePack({
      ...base,
      reviewRouting: routing({ receipt: 't2-auto', trustTier: { configured: 'T2', effective: 'T2' } }),
    });
    expect(md).toContain('- Trust tier: T2\n');
    expect(md).toContain('- Receipt: `t2-auto` — auto-merge without a human click, after required CI and policy gates');
  });

  it('renders a demoted trust tier with its reason', () => {
    const md = renderEvidencePack({
      ...base,
      reviewRouting: routing({ trustTier: { configured: 'T2', effective: 'T1', demotion: 'slip on #99' } }),
    });
    expect(md).toContain('- Trust tier: T2, demoted to T1 (slip on #99)');
    expect(md).not.toContain('Receipt:');
  });

  it('omits both lines when absent', () => {
    const md = renderEvidencePack({ ...base, reviewRouting: routing({}) });
    expect(md).not.toContain('Trust tier');
    expect(md).not.toContain('Receipt:');
  });
});
