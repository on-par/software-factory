import { describe, expect, it, vi } from 'vitest';

import { claudeKeychainChecks, doctorFailed } from './doctor.js';

describe('claudeKeychainChecks', () => {
  it('returns no keychain row and never probes on linux', () => {
    const probe = vi.fn(() => ({ status: 'skipped', detail: 'skipped — not macOS' }) as const);
    const rows = claudeKeychainChecks('linux', probe);
    expect(rows).toEqual([]);
    expect(rows.some((row) => row.name === 'claude keychain (macOS)')).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('returns no keychain row on win32', () => {
    const probe = vi.fn(() => ({ status: 'skipped', detail: 'skipped — not macOS' }) as const);
    const rows = claudeKeychainChecks('win32', probe);
    expect(rows).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('returns the claude keychain (macOS) row on darwin', () => {
    const probe = vi.fn(() => ({ status: 'readable' }) as const);
    const rows = claudeKeychainChecks('darwin', probe);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'claude keychain (macOS)', ok: true });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps the tmux hard-fail row on darwin', () => {
    const rows = claudeKeychainChecks('darwin', () => ({ status: 'unreadable', inTmux: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(false);
    expect(doctorFailed(rows)).toBe(true);
  });
});
