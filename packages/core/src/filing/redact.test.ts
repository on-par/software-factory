import { describe, expect, it } from 'vitest';

import { REDACTION_PLACEHOLDERS, redactText } from './redact.js';

const ctx = {
  repoSlugs: ['acme/private-app'],
  usernames: ['alice'],
  hostnames: ['alices-mbp.example.com'],
  branches: ['feature/secret-thing'],
};

describe('redactText', () => {
  it('redacts repo slug and bare name', () => {
    const out = redactText('failed in acme/private-app; private-app broke', ctx);
    expect(out).not.toMatch(/acme|private-app/);
    expect(out).toContain(REDACTION_PLACEHOLDERS.repo);
  });

  it('redacts explicit and factory branches, including a custom prefix', () => {
    const out = redactText('on feature/secret-thing and ship-it/123-foo and bot/45-bar', {
      ...ctx,
      branchPrefix: 'bot',
    });
    expect(out).not.toMatch(/secret-thing|123-foo|45-bar/);
    expect(out).toContain(REDACTION_PLACEHOLDERS.branch);
  });

  it('redacts absolute, home and windows paths', () => {
    const out = redactText('at /Users/alice/code/x.ts and ~/work/y and C:\\Users\\bob\\z.ts', {});
    expect(out).not.toMatch(/Users|work|bob|x\.ts/);
    expect(out).toContain(REDACTION_PLACEHOLDERS.path);
  });

  it('redacts usernames and @mentions', () => {
    const out = redactText('alice pinged @carol-d', ctx);
    expect(out).not.toMatch(/alice|carol/);
    expect(out).toContain(REDACTION_PLACEHOLDERS.user);
  });

  it('redacts hostnames, .local names and IPv4', () => {
    const out = redactText('alices-mbp.example.com, box.local, 10.0.0.12', ctx);
    expect(out).not.toMatch(/alices|box\.local|10\.0\.0/);
    expect(out).toContain(REDACTION_PLACEHOLDERS.host);
  });

  it('redacts emails', () => {
    const out = redactText('mail bob.smith+x@corp-mail.com now');
    expect(out).not.toContain('bob.smith');
    expect(out).toContain(REDACTION_PLACEHOLDERS.email);
  });

  it('redacts URLs and keeps trailing punctuation', () => {
    const out = redactText('see https://github.com/acme/secret-app/pull/1.');
    expect(out).toBe('see <url>.');
  });

  it.each([
    ['ghp', `ghp_${'a1'.repeat(15)}`],
    ['pat', `github_pat_${'Ab1_'.repeat(8)}`],
    ['anthropic', 'sk-ant-api03-abcdefghijklmnop'],
    ['aws', `AKIA${'ABCDEFGHIJKLMNOP'}`],
    ['jwt', 'eyJhbGciOi.eyJzdWIiOiIx.sigsigsig'],
    ['password', 'password=hunter2'],
    ['bearer', 'Bearer abc'],
    ['pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'],
    ['hex', 'deadbeef0123456789abcdef0123456789abcdef'],
  ])('redacts %s secrets', (_n, secret) => {
    const out = redactText(`x ${secret} y`);
    expect(out).toContain(REDACTION_PLACEHOLDERS.secret);
    expect(out).not.toMatch(/hunter2|abc$|MIIabc|deadbeef|AKIA|ghp_|github_pat_|sk-ant|eyJ/);
  });

  it('is idempotent', () => {
    const text = 'acme/private-app at /Users/alice/x.ts token=abc https://a.b/c a@b.com @bob 1.2.3.4 ship-it/1-x';
    const once = redactText(text, ctx);
    expect(redactText(once, ctx)).toBe(once);
  });

  it('handles empty, hidden content and clean text', () => {
    expect(redactText('')).toBe('');
    expect(redactText('a<!-- hidden -->b\u200Bc')).toBe('abc');
    expect(redactText('TypeError: cannot read properties of undefined')).toBe(
      'TypeError: cannot read properties of undefined',
    );
  });
});
