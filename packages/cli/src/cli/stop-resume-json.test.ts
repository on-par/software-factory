import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildStopResumeJson } from './stop-resume-json.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../__fixtures__/stop-resume-json/${name}.json`, import.meta.url), 'utf-8');

describe('buildStopResumeJson', () => {
  it('returns the exact shape and key order', () => {
    const built = buildStopResumeJson({ action: 'stop', repo: 'a/b', before: false, after: true });
    expect(built).toEqual({
      schemaVersion: 1,
      ok: true,
      action: 'stop',
      repo: 'a/b',
      stopFlag: { before: false, after: true },
    });
    expect(Object.keys(built)).toEqual(['schemaVersion', 'ok', 'action', 'repo', 'stopFlag']);
    expect(Object.keys(built.stopFlag)).toEqual(['before', 'after']);
  });

  it.each([
    ['stop', false, true],
    ['resume', true, false],
  ] as const)('matches the %s golden fixture byte-for-byte', (action, before, after) => {
    const built = buildStopResumeJson({ action, repo: 'on-par/example', before, after });
    const text = fixture(action);
    expect(built).toEqual(JSON.parse(text));
    expect(JSON.stringify(built, null, 2) + '\n').toBe(text);
  });
});
