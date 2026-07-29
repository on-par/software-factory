// packages/product/src/readiness/render.test.ts (#475).

import { describe, expect, it } from 'vitest';

import { renderReadinessReport } from './render.js';
import type { ReadinessDimension, ReadinessReport } from './report.js';
import { READINESS_DIMENSION_IDS } from './report.js';

const READY_DIMENSIONS: readonly ReadinessDimension[] = READINESS_DIMENSION_IDS.map((id) => ({
  id,
  label: id,
  ready: true,
  reason: `${id} is ready`,
}));

describe('renderReadinessReport', () => {
  it('renders a ready report with all dimensions and no open questions', () => {
    const report: ReadinessReport = { status: 'ready', dimensions: READY_DIMENSIONS, openQuestions: [] };
    const lines = renderReadinessReport(report);

    expect(lines).toContain('Status: ready');
    for (const dimension of READY_DIMENSIONS) {
      expect(lines).toContain(`- [ready] ${dimension.label}: ${dimension.reason}`);
    }
    expect(lines).toContain('No open questions.');
  });

  it('renders a not-ready report with the failing reason and both open-question sources', () => {
    const dimensions = READY_DIMENSIONS.map((d) =>
      d.id === 'technical-design' ? { ...d, ready: false, reason: 'missing the epic architecture document' } : d,
    );
    const report: ReadinessReport = {
      status: 'not-ready',
      dimensions,
      openQuestions: [
        { text: 'where does the port lease live?', forOwner: 'writer', source: 'epic-architecture' },
        {
          text: 'unrecorded architecture decision: event log schema versioning',
          forOwner: 'writer',
          source: 'adr-conformance',
        },
      ],
    };
    const lines = renderReadinessReport(report);

    expect(lines).toContain('Status: not-ready');
    expect(lines).toContain('- [not ready] technical-design: missing the epic architecture document');
    expect(lines).toContain('- (epic-architecture) where does the port lease live?');
    expect(lines).toContain('- (adr-conformance) unrecorded architecture decision: event log schema versioning');
  });
});
