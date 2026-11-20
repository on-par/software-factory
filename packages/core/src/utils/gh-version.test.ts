import { describe, expect, it } from 'vitest';

import { cmdResult } from '../test-support/visual-proof-test-helpers.js';
import { checkGhVersion } from './gh-version.js';

function reply(stdout: string, ok = true) {
  return async () => cmdResult({ stdout, ok, exitCode: ok ? 0 : -1 });
}

describe('checkGhVersion', () => {
  it('rejects gh older than 2.103.0 and names both versions', async () => {
    const diagnostic = await checkGhVersion(reply('gh version 2.92.0 (2026-04-28)\nhttps://github.com/cli/cli\n'));
    expect(diagnostic).toBe('gh 2.92.0 found, but gh 2.103.0 or newer is required for gh pr edit --attach');
  });

  it.each(['2.103.0', '2.105.1', '3.0.0'])('accepts gh %s', async (version) => {
    expect(await checkGhVersion(reply(`gh version ${version} (2026-11-01)\n`))).toBeUndefined();
  });

  it('reports a missing gh, a failing gh and unreadable version output', async () => {
    expect(await checkGhVersion(reply('', false))).toContain('gh was not found on PATH; gh 2.103.0 or newer');
    const failing = async () => cmdResult({ ok: false, exitCode: 4 });
    expect(await checkGhVersion(failing)).toContain('gh --version failed (exit 4); gh 2.103.0 or newer');
    expect(await checkGhVersion(reply('gh dev build'))).toContain('could not read a version from gh --version');
  });
});
