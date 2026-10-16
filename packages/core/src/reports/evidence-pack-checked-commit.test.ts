import { describe, expect, it } from 'vitest';

import { gatherEvidencePack, renderEvidencePack } from './evidence-pack.js';

describe('renderEvidencePack — checked commit SHA (#1812)', () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

  it('names the checked commit when headSha is given', () => {
    const rendered = renderEvidencePack({ issue: 1, events: [], logFiles: [], headSha: sha });
    expect(rendered).toContain(`Checked commit: \`${sha}\``);
  });

  it('omits the line when headSha is missing or blank', () => {
    expect(renderEvidencePack({ issue: 1, events: [], logFiles: [] })).not.toContain('Checked commit');
    expect(renderEvidencePack({ issue: 1, events: [], logFiles: [], headSha: '  ' })).not.toContain('Checked commit');
  });

  it('places the line after the summary and before the checker verdicts', () => {
    const rendered = renderEvidencePack({
      issue: 1,
      events: [],
      logFiles: [],
      headSha: sha,
      checkSummary: {
        failures: 0,
        passes: 1,
        skips: 0,
        total: 1,
        results: [{ checker: 'tests', result: 'PASS', details: 'OK' }],
      },
    });
    expect(rendered.indexOf('Checked commit')).toBeGreaterThan(-1);
    expect(rendered.indexOf('Checked commit')).toBeLessThan(rendered.indexOf('Checker verdicts'));
  });

  it('passes headSha through gatherEvidencePack', () => {
    expect(gatherEvidencePack({ issue: 385, headSha: 'deadbeef' })).toContain('Checked commit: `deadbeef`');
  });
});
