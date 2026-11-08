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
});
