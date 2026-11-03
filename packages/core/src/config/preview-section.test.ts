import { describe, expect, it } from 'vitest';

import { PreviewConfigSchema } from './preview-section.js';

const base = { source: { kind: 'deployment', environment: 'preview/pr-*' }, command: ['npm', 'run', 'smoke'] };
const comment = { kind: 'comment', urlPattern: '(?<url>https://\\S+)' };

describe('PreviewConfigSchema', () => {
  it('defaults readyPath to /, expectedStatus to 200, readyTimeoutSeconds to 300 and urlEnv to PREVIEW_URL', () => {
    const c = PreviewConfigSchema.parse(base);
    expect(c.readyPath).toBe('/');
    expect(c.expectedStatus).toBe(200);
    expect(c.readyTimeoutSeconds).toBe(300);
    expect(c.urlEnv).toBe('PREVIEW_URL');
    expect(c.commandTimeoutSeconds).toBe(600);
    expect(c.artifacts).toEqual([]);
  });

  it('parses both source kinds', () => {
    expect(PreviewConfigSchema.parse(base).source.kind).toBe('deployment');
    const c = PreviewConfigSchema.parse({ ...base, source: { ...comment, authors: ['vercel[bot]'] } });
    expect(c.source).toEqual({ ...comment, authors: ['vercel[bot]'], authorAssociations: [] });
  });

  it('accepts a comment source trusted by association level alone', () => {
    const c = PreviewConfigSchema.parse({ ...base, source: { ...comment, authorAssociations: ['MEMBER'] } });
    expect(c.source).toMatchObject({ authors: [], authorAssociations: ['MEMBER'] });
  });

  it.each([
    ['an unknown kind', { ...base, source: { kind: 'magic' } }],
    ['an invalid regex', { ...base, source: { ...comment, urlPattern: '(', authors: ['bot'] } }],
    ['a comment source that trusts no author', { ...base, source: comment }],
    ['an untrusted association level', { ...base, source: { ...comment, authorAssociations: ['CONTRIBUTOR'] } }],
    ['an absolute artifact path', { ...base, artifacts: ['/etc/passwd'] }],
    ['an artifact path outside the worktree', { ...base, artifacts: ['report/../../secret'] }],
    ['an empty command', { ...base, command: [] }],
    ['a bad urlEnv', { ...base, urlEnv: '1-bad' }],
    ['an unknown key', { ...base, extra: true }],
  ])('rejects %s', (_name, input) => {
    expect(PreviewConfigSchema.safeParse(input).success).toBe(false);
  });

  it.each(['/healthz', '/api/ready?probe=1', '/%2F%2Fstill-a-path'])('accepts the same-origin readyPath %s', (path) => {
    expect(PreviewConfigSchema.parse({ ...base, readyPath: path }).readyPath).toBe(path);
  });

  it.each([
    ['a relative path', 'healthz'],
    ['a protocol-relative host', '//169.254.169.254/latest'],
    ['a backslash host', '/\\10.0.0.5/x'],
    ['a leading double backslash', '\\\\10.0.0.5/x'],
    ['a slash then two backslashes', '/\\\\10.0.0.5/x'],
    ['a backslash then a slash', '\\/10.0.0.5/x'],
    ['a backslash later in the path', '/ok\\..\\x'],
    ['a tab the URL parser strips', '/\t/10.0.0.5/x'],
    ['a newline the URL parser strips', '/\n/10.0.0.5/x'],
  ])('rejects a readyPath that could leave the preview host: %s', (_name, path) => {
    expect(PreviewConfigSchema.safeParse({ ...base, readyPath: path }).success).toBe(false);
  });
});
