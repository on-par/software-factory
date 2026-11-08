import { describe, expect, it } from 'vitest';

import { collectKnownSecrets, createRedactor } from './redactor.js';

describe('collectKnownSecrets', () => {
  const env = {
    GH_TOKEN: 'gh-opaque-credential-1',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN KEY-----\nAAAABBBBCCCCDDDD1111\n-----END KEY-----',
    VENDOR_API_KEY: 'vendor-api-key-0001',
    DB_PASSWORD: 'correct-horse-battery',
    SHORT_TOKEN: 'abc',
    PATH: '/usr/bin:/bin',
    HOME: '/home/someone',
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Basic dXNlcjpwYXNzd29yZA==,x-tenant=tenant-name-01',
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'api-key=logs-key-1234567',
  };

  it('collects credential-like env values, their whitespace-separated parts, and OTLP header values', () => {
    const known = collectKnownSecrets(env);
    for (const v of [
      'gh-opaque-credential-1',
      'vendor-api-key-0001',
      'correct-horse-battery',
      'AAAABBBBCCCCDDDD1111',
      'Basic dXNlcjpwYXNzd29yZA==',
      'dXNlcjpwYXNzd29yZA==',
      'tenant-name-01',
      'logs-key-1234567',
    ])
      expect(known).toContain(v);
  });

  it('skips short values and non-credential names', () => {
    const known = collectKnownSecrets(env);
    expect(known).not.toContain('abc');
    expect(known).not.toContain('/usr/bin:/bin');
    expect(known).not.toContain('/home/someone');
    expect(known).not.toContain('Basic');
  });
});

describe('createRedactor', () => {
  it('masks known values longest first and calls the existing pattern sets', () => {
    const r = createRedactor(['dXNlcjpwYXNzd29yZA==', 'Basic dXNlcjpwYXNzd29yZA==', 'plainsecretvalue']);
    const text = [
      'h: Basic dXNlcjpwYXNzd29yZA==',
      'v: plainsecretvalue',
      'k: sk-ant-api03-abcdefghijklmnop',
      'aws AKIAABCDEFGHIJKLMNOP',
      'jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
      'pw password=hunter2hunter2',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'plain words stay',
    ].join('\n');
    const out = r.redact(text);
    for (const leak of [
      'dXNlcjpwYXNzd29yZA==',
      'plainsecretvalue',
      'sk-ant-api03',
      'AKIAABCDEFGHIJKLMNOP',
      'eyJhbGciOi',
      'hunter2hunter2',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    ])
      expect(out).not.toContain(leak);
    expect(out).toContain('plain words stay');
    expect(out).toContain('h: [redacted]');
  });

  it('sizes the hold-back to at least the longest known secret, within bounds', () => {
    expect(createRedactor([]).holdBack).toBe(1024);
    expect(createRedactor(['x'.repeat(3000)]).holdBack).toBeGreaterThanOrEqual(3000);
    expect(createRedactor(['x'.repeat(100_000)]).holdBack).toBeLessThanOrEqual(8192);
  });
});
