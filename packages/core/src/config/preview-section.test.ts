import { describe, expect, it } from 'vitest';

import { PreviewConfigSchema } from './preview-section.js';

const base = { source: { kind: 'deployment', environment: 'preview/pr-*' }, command: ['npm', 'run', 'smoke'] };

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
    const c = PreviewConfigSchema.parse({ ...base, source: { kind: 'comment', urlPattern: '(?<url>https://\\S+)' } });
    expect(c.source.kind).toBe('comment');
  });

  it.each([
    ['an unknown kind', { ...base, source: { kind: 'magic' } }],
    ['an invalid regex', { ...base, source: { kind: 'comment', urlPattern: '(' } }],
    ['an empty command', { ...base, command: [] }],
    ['a bad urlEnv', { ...base, urlEnv: '1-bad' }],
    ['an unknown key', { ...base, extra: true }],
  ])('rejects %s', (_name, input) => {
    expect(PreviewConfigSchema.safeParse(input).success).toBe(false);
  });
});
