import { describe, expect, it } from 'vitest';

import { doctorFailed } from './doctor.js';
import { refusedProviderChecks } from './doctor-failover-providers.js';

describe('refusedProviderChecks (#3335)', () => {
  it('gives no rows for no refusals', () => {
    expect(refusedProviderChecks([])).toEqual([]);
  });

  it('codex/api is an optional warning that says how to switch', () => {
    const [row] = refusedProviderChecks([{ provider: 'codex', login: 'api', models: ['m'] }]);
    expect(row).toMatchObject({ ok: false, optional: true, next: 'codex login' });
    expect(row?.fix).toContain('OPENAI_API_KEY');
    expect(doctorFailed([row!])).toBe(false);
  });

  it('claude rows point at claude /login', () => {
    const rows = refusedProviderChecks([
      { provider: 'claude', login: 'api', models: ['a'] },
      { provider: 'claude', login: 'unknown', models: ['a'] },
    ]);
    expect(rows.map((r) => r.next)).toEqual(['claude /login', 'claude /login']);
    expect(rows[1]?.detail).toBe('refused: no Claude subscription login found');
  });

  it('codex/unknown, opencode-go and other providers have their own detail', () => {
    const rows = refusedProviderChecks([
      { provider: 'codex', login: 'unknown', models: ['a'] },
      { provider: 'opencode-go', login: 'api', models: ['x', 'y'] },
      { provider: 'ghost', login: 'unknown', models: ['ghost'] },
    ]);
    expect(rows[0]?.detail).toBe('refused: no Codex ChatGPT login found');
    expect(rows[1]?.detail).toContain('x, y not an opencode-go/ model');
    expect(rows[2]?.detail).toBe('refused: not a subscription provider');
    expect(rows[2]?.next).toBeUndefined();
  });
});
