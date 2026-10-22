import { describe, expect, it } from 'vitest';

import { credentialFingerprint, credentialInputs, type CredentialFingerprintDeps } from './credential-fingerprint.js';

const deps = (over: Partial<CredentialFingerprintDeps> & { content?: string; mtime?: number } = {}) => ({
  env: {},
  homedir: () => '/home/u',
  stat: async () => ({ mtimeMs: over.mtime ?? 1 }),
  readFile: async () => over.content ?? 'secret-content-xyz',
  ...over,
});

describe('credentialFingerprint', () => {
  it('is stable for unchanged inputs and is 64 hex chars without any input value', async () => {
    const a = await credentialFingerprint('anthropic', deps({ env: { ANTHROPIC_API_KEY: 'sk-ant-VALUE' } }));
    const b = await credentialFingerprint('anthropic', deps({ env: { ANTHROPIC_API_KEY: 'sk-ant-VALUE' } }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('VALUE');
  });

  it('changes on file content, mtime, and an env value', async () => {
    const base = await credentialFingerprint('openai', deps());
    expect(await credentialFingerprint('openai', deps({ content: 'other' }))).not.toBe(base);
    expect(await credentialFingerprint('openai', deps({ mtime: 2 }))).not.toBe(base);
    expect(await credentialFingerprint('openai', deps({ env: { OPENAI_API_KEY: 'k' } }))).not.toBe(base);
  });

  it('does not throw when the file is missing', async () => {
    const missing = deps({
      stat: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(await credentialFingerprint('anthropic', missing)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('credentialInputs', () => {
  it('maps providers to their auth file and env, honouring the override env vars', () => {
    expect(credentialInputs('anthropic', { env: { CLAUDE_CONFIG_DIR: '/c' }, homedir: () => '/h' }).files).toEqual([
      '/c/.credentials.json',
    ]);
    expect(credentialInputs('anthropic', { env: {}, homedir: () => '/h' }).files).toEqual([
      '/h/.claude/.credentials.json',
    ]);
    expect(credentialInputs('openai', { env: { CODEX_HOME: '/x' }, homedir: () => '/h' }).files).toEqual([
      '/x/auth.json',
    ]);
    expect(credentialInputs('openai', { env: {}, homedir: () => '/h' }).env).toContain('CODEX_API_KEY');
    expect(credentialInputs('opencode', { env: { XDG_DATA_HOME: '/d' }, homedir: () => '/h' }).files).toEqual([
      '/d/opencode/auth.json',
    ]);
    expect(credentialInputs('opencode', { env: {}, homedir: () => '/h' }).files).toEqual([
      '/h/.local/share/opencode/auth.json',
    ]);
  });
});
