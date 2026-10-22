import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { credentialFingerprint, credentialSources } from './credential-fingerprint.js';

const tempDirs = createTempDirs();
afterEach(async () => {
  await tempDirs.cleanup();
});

async function home(): Promise<string> {
  return tempDirs.make('cred-fp-');
}

describe('credentialSources', () => {
  it('maps anthropic, openai and every other provider', () => {
    const env = {};
    expect(credentialSources('anthropic', env, '/h')).toEqual({
      files: ['/h/.claude/.credentials.json'],
      envVars: ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    });
    expect(credentialSources('openai', { CODEX_HOME: '/cx' }, '/h').files).toEqual(['/cx/auth.json']);
    expect(credentialSources('openai', env, '/h').files).toEqual(['/h/.codex/auth.json']);
    const other = credentialSources('custom', { XDG_DATA_HOME: '/x' }, '/h');
    expect(other.files).toEqual(['/h/.claude/.credentials.json', '/h/.codex/auth.json', '/x/opencode/auth.json']);
    expect(other.envVars).toContain('XDG_DATA_HOME');
    expect(other.envVars).toContain('OPENAI_API_KEY');
  });
});

describe('credentialFingerprint', () => {
  it('is stable, and changes with content, mtime or env', async () => {
    const h = await home();
    const file = join(h, '.claude', '.credentials.json');
    await import('node:fs/promises').then((fs) => fs.mkdir(join(h, '.claude')));
    await writeFile(file, 'secret-one');
    await utimes(file, 1000, 1000);
    const fp = (env: NodeJS.ProcessEnv = {}) => credentialFingerprint('anthropic', { env, homedir: () => h });
    const base = await fp();
    expect(await fp()).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);

    await utimes(file, 2000, 2000);
    const touched = await fp();
    expect(touched).not.toBe(base);

    await writeFile(file, 'secret-two');
    await utimes(file, 2000, 2000);
    const rewritten = await fp();
    expect(rewritten).not.toBe(touched);

    const withEnv = await fp({ ANTHROPIC_API_KEY: 'sk-ant-THEKEY' });
    expect(withEnv).not.toBe(rewritten);
    expect(withEnv).not.toContain('THEKEY');
    expect(withEnv).not.toContain('secret');
  });

  it('does not throw for a missing file and tells it apart from a present one', async () => {
    const h = await home();
    const missing = await credentialFingerprint('openai', { env: {}, homedir: () => h });
    expect(missing).toMatch(/^[0-9a-f]{64}$/);
    await import('node:fs/promises').then((fs) => fs.mkdir(join(h, '.codex')));
    await writeFile(join(h, '.codex', 'auth.json'), '{}');
    expect(await credentialFingerprint('openai', { env: {}, homedir: () => h })).not.toBe(missing);
  });

  it('treats an unreadable file as missing', async () => {
    const throwing = async (): Promise<never> => {
      throw new Error('EACCES');
    };
    const a = await credentialFingerprint('anthropic', {
      env: {},
      homedir: () => '/h',
      stat: throwing,
      readFile: throwing,
    });
    const b = await credentialFingerprint('anthropic', { env: {}, homedir: () => '/h' });
    expect(a).toBe(b);
  });
});
