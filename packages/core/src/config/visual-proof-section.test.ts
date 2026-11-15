import { describe, expect, it } from 'vitest';

import { VisualProofConfigSchema } from './visual-proof-section.js';

const route = { route: '/settings', assert: 'Settings', paths: ['src/settings/**'] };
const base = { uiPaths: ['src/**'], routes: [route], command: ['node', 'capture.mjs'] };

describe('VisualProofConfigSchema (#2232)', () => {
  it('applies defaults', () => {
    const parsed = VisualProofConfigSchema.parse(base);
    expect(parsed).toMatchObject({ maxCaptures: 3, timeoutSeconds: 300, evidenceBranch: 'factory-evidence' });
    expect(parsed.routes[0]).toMatchObject({ state: 'default', viewport: { width: 1280, height: 800 } });
  });

  it('defaults mode to required and accepts the three modes (#4047)', () => {
    expect(VisualProofConfigSchema.parse(base).mode).toBe('required');
    for (const mode of ['required', 'advisory', 'off'] as const) {
      expect(VisualProofConfigSchema.parse({ ...base, mode }).mode).toBe(mode);
    }
    expect(VisualProofConfigSchema.safeParse({ ...base, mode: 'warn' }).success).toBe(false);
    expect(VisualProofConfigSchema.safeParse({ ...base, mode: true }).success).toBe(false);
  });

  it('enforces bounds', () => {
    const bad = (patch: Record<string, unknown>) => VisualProofConfigSchema.safeParse({ ...base, ...patch }).success;
    expect(bad({ maxCaptures: 6 })).toBe(false);
    expect(bad({ maxCaptures: 0 })).toBe(false);
    expect(bad({ routes: [] })).toBe(false);
    expect(bad({ routes: Array.from({ length: 11 }, () => route) })).toBe(false);
    expect(bad({ command: [] })).toBe(false);
    expect(bad({ uiPaths: [] })).toBe(false);
    expect(bad({ timeoutSeconds: 0 })).toBe(false);
    expect(bad({ routes: [{ ...route, viewport: { width: 100, height: 800 } }] })).toBe(false);
    expect(bad({ routes: [{ ...route, viewport: { width: 1280, height: 5000 } }] })).toBe(false);
    expect(bad({ routes: [{ ...route, route: '//evil.test' }] })).toBe(false);
    expect(bad({ routes: [{ ...route, route: 'settings' }] })).toBe(false);
  });

  it('rejects unknown keys at the top level and in routes', () => {
    expect(VisualProofConfigSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(VisualProofConfigSchema.safeParse({ ...base, routes: [{ ...route, extra: 1 }] }).success).toBe(false);
  });

  it('rejects evidence branches that are factory/ prefixed or malformed', () => {
    const branch = (evidenceBranch: string) => VisualProofConfigSchema.safeParse({ ...base, evidenceBranch }).success;
    expect(branch('factory/evidence')).toBe(false);
    expect(branch('bad branch')).toBe(false);
    expect(branch('proof/images')).toBe(true);
  });

  const stateful = {
    ...route,
    state: 'item-created',
    steps: [
      { goto: '/items' },
      { click: '#new' },
      { fill: '#name', value: '' },
      { press: 'Enter' },
      { waitFor: '#item-1' },
    ],
    record: 'gif',
  };

  it('accepts a stateful route with every step kind', () => {
    const parsed = VisualProofConfigSchema.parse({ ...base, routes: [stateful] });
    expect(parsed.routes[0]).toMatchObject({ state: 'item-created', record: 'gif' });
    expect(parsed.routes[0]?.steps).toHaveLength(5);
    expect(VisualProofConfigSchema.safeParse({ ...base, routes: [{ ...stateful, record: 'video' }] }).success).toBe(
      true,
    );
  });

  it('rejects an unknown step, a cross-origin goto and record without steps', () => {
    const bad = (patch: Record<string, unknown>) =>
      VisualProofConfigSchema.safeParse({ ...base, routes: [{ ...route, ...patch }] });
    expect(bad({ steps: [{ hover: '#a' }] }).success).toBe(false);
    expect(bad({ steps: [{ click: '#a', extra: 1 }] }).success).toBe(false);
    expect(bad({ steps: [{ goto: '//evil.test' }] }).success).toBe(false);
    expect(bad({ steps: [] }).success).toBe(false);
    expect(bad({ steps: Array.from({ length: 21 }, () => ({ press: 'Enter' })) }).success).toBe(false);
    const noSteps = bad({ record: 'gif' });
    expect(noSteps.success).toBe(false);
    expect(JSON.stringify(noSteps.error?.issues)).toContain('record needs steps');
    expect(bad({ steps: [{ press: 'Enter' }], record: 'mp4' }).success).toBe(false);
  });

  it('defaults captureAttempts to 3 and leaves stepless routes unchanged', () => {
    const parsed = VisualProofConfigSchema.parse(base);
    expect(parsed.captureAttempts).toBe(3);
    expect(parsed.routes[0]).not.toHaveProperty('steps');
    expect(parsed.routes[0]).not.toHaveProperty('record');
    expect(VisualProofConfigSchema.safeParse({ ...base, captureAttempts: 0 }).success).toBe(false);
    expect(VisualProofConfigSchema.safeParse({ ...base, captureAttempts: 6 }).success).toBe(false);
    expect(VisualProofConfigSchema.parse({ ...base, captureAttempts: 5 }).captureAttempts).toBe(5);
  });
});
