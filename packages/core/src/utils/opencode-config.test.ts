import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { hasOpencodeLoginEvidence } from './opencode-config.js';

const home = () => '/home/u';
const reading = (content: string) => vi.fn(() => content);

describe('hasOpencodeLoginEvidence', () => {
  it('is true when auth.json has a credential entry', () => {
    const readFile = reading('{"opencode-go":{"type":"api","key":"x"}}');
    expect(hasOpencodeLoginEvidence({ env: {}, homedir: home, readFile })).toBe(true);
  });

  it('is false when the file is missing', () => {
    const readFile = vi.fn(() => {
      throw new Error('ENOENT');
    });
    expect(hasOpencodeLoginEvidence({ env: {}, homedir: home, readFile })).toBe(false);
  });

  it.each(['', 'not json', '{}', '[]', 'null', '[{"a":1}]', '"str"'])('is false for content %j', (content) => {
    expect(hasOpencodeLoginEvidence({ env: {}, homedir: home, readFile: reading(content) })).toBe(false);
  });

  it('honors XDG_DATA_HOME', () => {
    const readFile = reading('{"a":{}}');
    hasOpencodeLoginEvidence({ env: { XDG_DATA_HOME: '/xdg' }, homedir: home, readFile });
    expect(readFile).toHaveBeenCalledWith(join('/xdg', 'opencode', 'auth.json'));
  });

  it.each([undefined, '', '  '])('falls back to ~/.local/share when XDG_DATA_HOME is %j', (xdg) => {
    const readFile = reading('{"a":{}}');
    hasOpencodeLoginEvidence({ env: { XDG_DATA_HOME: xdg }, homedir: home, readFile });
    expect(readFile).toHaveBeenCalledWith(join('/home/u', '.local', 'share', 'opencode', 'auth.json'));
  });

  it('does not throw with default deps', () => {
    expect(typeof hasOpencodeLoginEvidence()).toBe('boolean');
  });
});
