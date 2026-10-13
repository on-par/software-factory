import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { checkNodeVersion, MIN_NODE_MAJOR } from './node-version.js';

describe('checkNodeVersion', () => {
  it('rejects a major below the minimum', () => {
    const old = checkNodeVersion('v20.11.1');
    expect(old.ok).toBe(false);
    if (!old.ok) {
      expect(old.message).toContain('needs Node.js 24 or newer (found v20.11.1)');
      expect(old.message).toContain('nvm install 24 && nvm use 24');
      expect(old.message).toContain('npm install -g @on-par/factory-cli');
    }
    expect(checkNodeVersion('v23.9.0').ok).toBe(false);
  });

  it('pins the running CLI version in the reinstall line', () => {
    const pinned = checkNodeVersion('v20.11.1', '0.9.3');
    expect(pinned.ok).toBe(false);
    if (!pinned.ok) expect(pinned.message).toContain('npm install -g @on-par/factory-cli@0.9.3');
    for (const unpinned of [checkNodeVersion('v20.11.1'), checkNodeVersion('v20.11.1', '')]) {
      expect(unpinned.ok).toBe(false);
      if (!unpinned.ok) expect(unpinned.message.endsWith('npm install -g @on-par/factory-cli')).toBe(true);
    }
  });

  it('accepts the exact minimum and newer majors', () => {
    for (const v of ['v24.0.0', 'v24.10.1', 'v25.2.0']) {
      expect(checkNodeVersion(v)).toEqual({ ok: true });
    }
  });

  it('rejects malformed versions', () => {
    expect(checkNodeVersion('').ok).toBe(false);
    const garbage = checkNodeVersion('garbage');
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.message).toContain('found garbage');
    const empty = checkNodeVersion('');
    if (!empty.ok) expect(empty.message).toContain('found unknown');
  });

  it('accepts a version without the leading v', () => {
    expect(checkNodeVersion('24.1.0').ok).toBe(true);
    const old = checkNodeVersion('20.0.0');
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.message).toContain('found v20.0.0');
  });

  it('MIN_NODE_MAJOR matches engines.node', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}.0.0`);
  });
});
