import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadFactoryConfig, loadFactoryConfigForRepo } from './index.js';
import {
  markSizeGateModeWarned,
  resolveSizeGateMode,
  sizeGateModeValueIssue,
  warnSizeGateModeOnce,
} from './size-gate.js';

function withMode(mode: string) {
  return { ...loadFactoryConfig(), sizeGate: { mode } };
}

describe('resolveSizeGateMode unknown mode warning (#3850)', () => {
  it.each(['Off', 'bogus'])('warns once naming %s and off, stack, and resolves to stack (#3850)', (mode) => {
    const warn = vi.fn<(line: string) => void>();
    const config = withMode(mode);
    expect(resolveSizeGateMode(config, warn)).toBe('stack');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]![0];
    expect(line).toContain(`"${mode}"`);
    expect(line).toContain('off, stack');
    expect(line).toContain('runs as stack');
    expect(resolveSizeGateMode(config, warn)).toBe('stack');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for a missing mode, off or stack (#3850)', () => {
    const warn = vi.fn<(line: string) => void>();
    expect(resolveSizeGateMode(loadFactoryConfig(), warn)).toBe('stack');
    expect(resolveSizeGateMode(withMode('off'), warn)).toBe('off');
    expect(resolveSizeGateMode(withMode('stack'), warn)).toBe('stack');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('sizeGateModeValueIssue (#3850)', () => {
  it.each([
    {},
    { sizeGate: {} },
    ...['off', 'stack', 'file', 'slice'].map((mode) => ({ sizeGate: { mode } })),
    { sizeGate: { mode: false } },
  ])('returns nothing for %j', (raw) => {
    expect(sizeGateModeValueIssue(raw)).toBeUndefined();
  });

  it.each(['', 'none', 'STACK'])('reports %j', (mode) => {
    const issue = sizeGateModeValueIssue({ sizeGate: { mode } });
    expect(issue?.value).toBe(mode);
    expect(issue?.message).toContain(JSON.stringify(mode));
    expect(issue?.message).toContain('off, stack');
  });
});

describe('warnSizeGateModeOnce and markSizeGateModeWarned (#3850)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns once per path and value and reports true', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = { sizeGate: { mode: 'bogus' } };
    expect(warnSizeGateModeOnce('/a/size-gate-once.yaml', raw)).toBe(true);
    expect(warnSizeGateModeOnce('/a/size-gate-once.yaml', raw)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('/a/size-gate-once.yaml');
  });

  it('returns false for a valid mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(warnSizeGateModeOnce('/a/valid.yaml', { sizeGate: { mode: 'off' } })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a marked config does not warn on resolve', () => {
    const warn = vi.fn<(line: string) => void>();
    const config = withMode('bogus');
    markSizeGateModeWarned(config);
    expect(resolveSizeGateMode(config, warn)).toBe('stack');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('loadFactoryConfigForRepo unknown sizeGate.mode (#3850)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loadFactoryConfigForRepo warns once for an unknown sizeGate.mode and resolves it to stack (#3850)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-config-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const path = join(dir, 'config.json');
      await writeFile(path, JSON.stringify({ sizeGate: { mode: 'bogus' } }));
      const config = loadFactoryConfigForRepo(path);
      expect(resolveSizeGateMode(config)).toBe('stack');
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain(path);
      expect(line).toContain('"bogus"');
      expect(line).toContain('off, stack');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
