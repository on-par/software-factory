import { describe, expect, it } from 'vitest';

import { claudeKeychainChecks, doctorFailed } from './doctor.js';

describe('claudeKeychainChecks', () => {
  it('returns no keychain row and never probes on linux', () => {
    const probe = () => {
      throw new Error('probed');
    };
    const rows = claudeKeychainChecks('linux', probe);
    expect(rows).toEqual([]);
    expect(rows.some((row) => row.name === 'claude keychain (macOS)')).toBe(false);
  });

  it('returns no keychain row on win32', () => {
    const probe = () => {
      throw new Error('probed');
    };
    const rows = claudeKeychainChecks('win32', probe);
    expect(rows).toEqual([]);
  });

  it('returns the claude keychain (macOS) row on darwin', () => {
    const probe = () => ({ status: 'readable' }) as const;
    const rows = claudeKeychainChecks('darwin', probe);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'claude keychain (macOS)', ok: true });
    const unreadable = claudeKeychainChecks('darwin', () => ({ status: 'unreadable', inTmux: false }));
    expect(unreadable[0]?.ok).toBe(false);
  });

  it('keeps the tmux hard-fail row on darwin', () => {
    const rows = claudeKeychainChecks('darwin', () => ({ status: 'unreadable', inTmux: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(false);
    expect(doctorFailed(rows)).toBe(true);
  });
});
