import { describe, expect, it } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { renderEvidencePack } from './evidence-pack.js';

describe('renderEvidencePack — T1 sample (#1958)', () => {
  const base = { issue: workKeyFromIssue(1), events: [], logFiles: [] };
  const routing = (held: boolean) => ({
    floor: 'A' as const,
    gated: held,
    rules: [],
    sample: { value: 0.1034, rate: 0.25, held },
  });

  it('renders a held sample', () => {
    const md = renderEvidencePack({ ...base, reviewRouting: routing(true) });
    expect(md).toContain('- T1 sample: 0.1034 vs rate 0.25 — held for a human (t1-sampled)');
  });

  it('renders a sample that was not held', () => {
    const md = renderEvidencePack({ ...base, reviewRouting: routing(false) });
    expect(md).toContain('- T1 sample: 0.1034 vs rate 0.25 — not sampled');
  });

  it('omits the line when no sample was taken', () => {
    const md = renderEvidencePack({ ...base, reviewRouting: { floor: 'A', gated: false, rules: [] } });
    expect(md).not.toContain('T1 sample');
  });
});
