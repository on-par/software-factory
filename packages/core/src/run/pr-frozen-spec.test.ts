// packages/core/src/run/pr-frozen-spec.test.ts — the frozen spec comment round-trips and rejects forged, tampered and oversized blocks (#4025)
import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import type { SelfIdentity } from '../utils/github-identity.js';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  decodePrFrozenSpec,
  encodePrFrozenSpec,
  prFrozenSpecMarker,
  savePrFrozenSpec,
  selectTrustedPrFrozenSpec,
  type PrFrozenSpec,
} from './pr-frozen-spec.js';
import { MAX_ENCODED_CHARS } from './pr-run-state.js';

const key = workKeyFromIssue(42);
const SELF = 7;
const self: SelfIdentity = { id: SELF, login: 'factory', kind: 'user' };

const frozen = (over: Partial<PrFrozenSpec> = {}): PrFrozenSpec => ({
  version: 1,
  key,
  bodyHash: 'a'.repeat(64),
  spec: '---\nroute: claude\n---\n# Spec\n',
  ...over,
});
const encoded = (over: Partial<PrFrozenSpec> = {}): string => encodePrFrozenSpec(frozen(over)) ?? '';

describe('pr frozen spec', () => {
  it('round-trips a frozen spec through encode and decode', () => {
    expect(encoded()).toContain(prFrozenSpecMarker(key));
    expect(decodePrFrozenSpec(encoded(), key)).toEqual({ ok: true, state: frozen() });
    expect(decodePrFrozenSpec('no marker here', key)).toBeNull();
  });

  it('rejects a forged author, a tampered digest and a wrong key', () => {
    const good = encoded();
    const tampered = good.replace(/factory:frozen-spec-data [^ ]+/, () => {
      const json = JSON.stringify({ ...frozen(), spec: 'evil' });
      return `factory:frozen-spec-data ${Buffer.from(json).toString('base64')}`;
    });
    const comments = [
      { id: 1, authorId: 99, body: good },
      { id: 2, authorId: SELF, body: tampered },
      { id: 3, authorId: SELF, body: good.replace(`key:${key}`, 'key:other') },
      { id: 4, authorId: SELF, body: good.replace(/<!-- factory:frozen-spec-data .*/, '') },
    ];
    expect(selectTrustedPrFrozenSpec(comments, self, key)).toEqual({
      status: 'none',
      ignored: [
        { commentId: 1, reason: 'untrusted-author' },
        { commentId: 2, reason: 'digest-mismatch' },
        { commentId: 3, reason: 'key-mismatch' },
        { commentId: 4, reason: 'malformed' },
      ],
    });
    const trusted = selectTrustedPrFrozenSpec([{ id: 5, authorId: SELF, body: good }], self, key);
    expect(trusted).toMatchObject({ status: 'found', commentId: 5, state: frozen() });
  });

  it('reports malformed for bad json and unknown fields', () => {
    const wrap = (json: string): string =>
      `${prFrozenSpecMarker(key)}\n<!-- factory:frozen-spec-data ${Buffer.from(json).toString('base64')} sha256:${'0'.repeat(64)} -->`;
    expect(decodePrFrozenSpec(wrap('{nope'), key)).toEqual({ ok: false, reason: 'malformed' });
    expect(decodePrFrozenSpec(wrap(JSON.stringify({ ...frozen(), extra: 1 })), key)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('ignores every marker when the identity is unavailable', () => {
    expect(selectTrustedPrFrozenSpec([{ id: 1, authorId: SELF, body: encoded() }], undefined, key)).toEqual({
      status: 'none',
      ignored: [{ commentId: 1, reason: 'identity-unavailable' }],
    });
  });

  it('returns null from encode when the block exceeds one comment', async () => {
    const big = frozen({ spec: 'x'.repeat(MAX_ENCODED_CHARS) });
    expect(encodePrFrozenSpec(big)).toBeNull();
    const octokit = new Proxy({}, { get: () => assertNoApi() }) as Octokit;
    expect(await savePrFrozenSpec({ octokit, repo: 'o/r', prNumber: 9, state: big })).toBeNull();
  });

  it('redacts secrets in the stored spec', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const decoded = decodePrFrozenSpec(encoded({ spec: `# Spec\ntoken ${token}\n` }), key);
    expect(decoded?.ok && decoded.state.spec).not.toContain(token);
  });
});

function assertNoApi(): never {
  throw new Error('the API must not be called');
}
