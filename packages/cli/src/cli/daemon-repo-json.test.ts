import { describe, expect, it } from 'vitest';

import { buildDaemonRepoJson } from './daemon-repo-json.js';

describe('buildDaemonRepoJson', () => {
  it('emits keys in fixed order and omits reason when ok', () => {
    const json = buildDaemonRepoJson({ action: 'attach', repo: 'a/b', ok: true, reason: 'ignored' });
    expect(JSON.stringify(json)).toBe('{"schemaVersion":1,"ok":true,"action":"attach","repo":"a/b"}');
  });

  it('includes reason last on failure, and allows a null repo', () => {
    const json = buildDaemonRepoJson({ action: 'detach', repo: null, ok: false, reason: 'x' });
    expect(JSON.stringify(json)).toBe('{"schemaVersion":1,"ok":false,"action":"detach","repo":null,"reason":"x"}');
  });

  it('omits reason on failure when none given', () => {
    expect(Object.keys(buildDaemonRepoJson({ action: 'detach', repo: 'a/b', ok: false }))).toEqual([
      'schemaVersion',
      'ok',
      'action',
      'repo',
    ]);
  });
});
