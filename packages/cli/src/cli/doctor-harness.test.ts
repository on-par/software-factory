import { describe, expect, it } from 'vitest';

import { formatDoctorChecks } from './doctor.js';
import { harnessInstallChecks } from './doctor-harness.js';

describe('opencode installed version check (#2880)', () => {
  const RANGE = '>=1.18.0 <2.1.0';
  const PIN = 'npm install -g opencode-ai@1.18.28';
  const row = (out: string | null) =>
    harnessInstallChecks(
      () => true,
      (cmd) => (cmd.startsWith('opencode') ? out : 'x'),
    ).find((c) => c.name === 'opencode installed')!;

  it('opencode installed is ok and names the version and supported range for 1.18.28', () => {
    const r = row('1.18.28');
    expect(r).toMatchObject({ ok: true, optional: true });
    expect(r.detail).toContain('1.18.28');
    expect(r.detail).toContain(RANGE);
    expect(r).not.toHaveProperty('fix');
  });

  it('opencode installed warns with the range and pinned install for 3.0.1', () => {
    const r = row('3.0.1');
    expect(r).toMatchObject({ ok: false, optional: true });
    expect(r.detail).toContain('3.0.1');
    expect(r.detail).toContain(RANGE);
    expect(r.detail).toContain(PIN);
    expect(r.fix).toBe(`install the tested OpenCode: ${PIN}`);
    expect(formatDoctorChecks([r])).toContain('⚠️');
  });

  it.each(['dev', '', null])('opencode installed is ok with version unknown and the range for %j', (out) => {
    const r = row(out);
    expect(r).toMatchObject({ ok: true, optional: true });
    expect(r.detail).toContain('version unknown');
    expect(r.detail).toContain(RANGE);
  });

  it.each([
    ['1.17.9', false],
    ['2.1.0', false],
    ['2.0.29', true],
    ['opencode 1.18.0\nextra', true],
  ])('boundary %j -> ok %s', (out, ok) => {
    expect(row(out).ok).toBe(ok);
  });
});

describe('opencode not installed (#2880)', () => {
  it('fix is the exact pinned install command', () => {
    const row = harnessInstallChecks(
      () => false,
      () => null,
    ).find((c) => c.name === 'opencode installed')!;
    expect(row.fix).toBe('install OpenCode: npm install -g opencode-ai@1.18.28');
  });
});

describe('pi installed row (#2903)', () => {
  it('pi installed shows the pi --version output (#2903)', () => {
    const row = harnessInstallChecks(
      () => true,
      (cmd) => (cmd === 'pi --version' ? '1.2.0\n' : 'x'),
    ).find((c) => c.name === 'pi installed')!;
    expect(row).toMatchObject({ ok: true, section: 'Pi', detail: 'found on PATH (1.2.0)' });
  });

  it('a missing pi is optional and names the install command', () => {
    const row = harnessInstallChecks(
      (cmd) => cmd !== 'pi',
      () => null,
    ).find((c) => c.name === 'pi installed')!;
    expect(row).toMatchObject({ ok: false, optional: true, section: 'Pi' });
    expect(row.fix).toContain('@earendil-works/pi-coding-agent');
  });
});
