import { describe, expect, it } from 'vitest';

import {
  credentialFingerprint,
  credentialSourcesFor,
  type CredentialFingerprintDeps,
} from './credential-fingerprint.js';

const SECRET = 'sk-ant-supersecretvalue';

function deps(over: Partial<CredentialFingerprintDeps> = {}, files: Record<string, string> = {}) {
  return {
    env: {},
    homedir: () => '/home/u',
    readFile: (p: string) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
    statMtimeMs: () => 1000,
    ...over,
  } satisfies CredentialFingerprintDeps;
}

const CLAUDE_FILE = '/home/u/.claude/.credentials.json';

describe('credentialFingerprint', () => {
  it('is a stable 64-char hex digest with no raw value', () => {
    const d = deps({ env: { ANTHROPIC_API_KEY: SECRET } }, { [CLAUDE_FILE]: SECRET });
    const fp = credentialFingerprint('anthropic', d);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).toBe(credentialFingerprint('anthropic', d));
    expect(fp).not.toContain(SECRET);
  });

  it('changes on content, mtime and env var changes', () => {
    const base = credentialFingerprint('anthropic', deps({}, { [CLAUDE_FILE]: 'a' }));
    expect(credentialFingerprint('anthropic', deps({}, { [CLAUDE_FILE]: 'b' }))).not.toBe(base);
    expect(credentialFingerprint('anthropic', deps({ statMtimeMs: () => 2000 }, { [CLAUDE_FILE]: 'a' }))).not.toBe(
      base,
    );
    expect(
      credentialFingerprint('anthropic', deps({ env: { ANTHROPIC_API_KEY: 'k' } }, { [CLAUDE_FILE]: 'a' })),
    ).not.toBe(base);
  });

  it('never throws for missing files or a throwing stat', () => {
    expect(credentialFingerprint('anthropic', deps())).toMatch(/^[0-9a-f]{64}$/);
    expect(
      credentialFingerprint(
        'openai',
        deps({
          statMtimeMs: () => {
            throw new Error('boom');
          },
        }),
      ),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('credentialSourcesFor', () => {
  it('maps anthropic and openai to their own sources', () => {
    const a = credentialSourcesFor('anthropic', deps());
    expect(a.files).toEqual([CLAUDE_FILE]);
    expect(a.envVars).toContain('ANTHROPIC_API_KEY');
    const o = credentialSourcesFor('openai', deps({ env: { CODEX_HOME: '/codex' } }));
    expect(o.files).toEqual(['/codex/auth.json']);
    expect(o.envVars).toContain('CODEX_API_KEY');
  });

  it('uses the union for unknown providers', () => {
    for (const p of ['custom', 'ollama', '']) {
      const s = credentialSourcesFor(p, deps());
      expect(s.files).toContain(CLAUDE_FILE);
      expect(s.files).toContain('/home/u/.codex/auth.json');
      expect(s.files).toContain('/home/u/.local/share/opencode/auth.json');
      expect(s.envVars).toContain('XDG_DATA_HOME');
    }
  });
});
