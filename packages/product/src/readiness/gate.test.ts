// packages/product/src/readiness/gate.test.ts (#475).

import { describe, expect, it } from 'vitest';

import { gateHandoff } from './gate.js';
import type { ReadinessDimension, ReadinessReport } from './report.js';

function buildDimension(overrides: Partial<ReadinessDimension> = {}): ReadinessDimension {
  return { id: 'intent', label: 'Intent', ready: true, reason: 'intent doc is approved', ...overrides };
}

function buildReport(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  const dimensions = overrides.dimensions ?? [buildDimension()];
  return {
    status: dimensions.every((d) => d.ready) ? 'ready' : 'not-ready',
    dimensions,
    openQuestions: [],
    ...overrides,
  };
}

describe('gateHandoff', () => {
  it('approves a ready report with a named approver', () => {
    const report = buildReport();
    const decision = gateHandoff(report, 'Pat');

    expect(decision).toEqual({ ok: true, report, approvedBy: 'Pat' });
  });

  it('blocks a ready report with a blank approver', () => {
    const report = buildReport();
    const decision = gateHandoff(report, '  ');

    expect(decision).toEqual({ ok: false, report, blockers: ['handoff needs a named human approver'] });
  });

  it('blocks and reports the missing epic architecture document for a not-ready report', () => {
    const notReadyDimension = buildDimension({
      id: 'technical-design',
      label: 'Technical design',
      ready: false,
      reason: 'missing the epic architecture document',
    });
    const report = buildReport({ dimensions: [buildDimension(), notReadyDimension] });
    const decision = gateHandoff(report, 'Pat');

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.blockers).toEqual(['missing the epic architecture document']);
    }
  });

  it('blocks with both the dimension reason and the missing-approver reason when both are absent', () => {
    const notReadyDimension = buildDimension({ ready: false, reason: 'intent doc missing' });
    const report = buildReport({ dimensions: [notReadyDimension] });
    const decision = gateHandoff(report, '');

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.blockers).toEqual(['intent doc missing', 'handoff needs a named human approver']);
    }
  });
});
