import { describe, expect, it } from 'vitest';

import {
  childProcessEnv,
  isGitHubCredentialEnvVar,
  redactExecError,
  redactGitHubCredentials,
  withoutGitHubCredentials,
} from './github-credentials.js';

describe('isGitHubCredentialEnvVar', () => {
  it.each([
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_PAT',
    'GH_PAT',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'COPILOT_GITHUB_TOKEN',
    'HOMEBREW_GITHUB_API_TOKEN',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_CLIENT_SECRET',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'github_token',
  ])('flags %s', (name) => {
    expect(isGitHubCredentialEnvVar(name)).toBe(true);
  });

  it.each([
    'PATH',
    'HOME',
    'GITHUB_ACTIONS',
    'GITHUB_REPOSITORY',
    'GH_HOST',
    'GH_REPO',
    'GITHUB_SHA',
    'ANTHROPIC_API_KEY',
    'NPM_TOKEN',
    'LIGHT_TOKEN',
    'FACTORY_BASE_URL',
  ])('leaves %s alone', (name) => {
    expect(isGitHubCredentialEnvVar(name)).toBe(false);
  });
});

describe('withoutGitHubCredentials', () => {
  it('drops credential vars and keeps everything else', () => {
    expect(
      withoutGitHubCredentials({ PATH: '/bin', GITHUB_TOKEN: 'a', GH_TOKEN: 'b', GITHUB_PAT: 'c', HOME: '/h' }),
    ).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('childProcessEnv', () => {
  const parent = { PATH: '/bin', GITHUB_TOKEN: 'parent-token', FACTORY_HEADLESS: '0' };

  it('merges overrides over the parent and strips GitHub credentials by default', () => {
    expect(childProcessEnv(parent, { FACTORY_HEADLESS: '1', PORT: '3142' })).toEqual({
      PATH: '/bin',
      FACTORY_HEADLESS: '1',
      PORT: '3142',
    });
  });

  it('strips a credential passed explicitly as an override too', () => {
    expect(childProcessEnv(parent, { GH_TOKEN: 'smuggled' })).toEqual({ PATH: '/bin', FACTORY_HEADLESS: '0' });
  });

  it('keeps the credentials when githubAuth is set', () => {
    expect(childProcessEnv(parent, undefined, { githubAuth: true })).toEqual(parent);
  });

  it('preserves explicit undefined overrides (deletions) for the spawner', () => {
    const env = childProcessEnv(parent, { FACTORY_HEADLESS: undefined });
    expect('FACTORY_HEADLESS' in env).toBe(true);
    expect(env.FACTORY_HEADLESS).toBeUndefined();
  });
});

describe('redactGitHubCredentials', () => {
  it('masks the literal value of every credential var in env, even with no known prefix', () => {
    const env = { GITHUB_TOKEN: 'opaque-secret-value', GH_TOKEN: 'another-opaque-one', PATH: '/usr/bin/longpath' };
    expect(redactGitHubCredentials('a opaque-secret-value b another-opaque-one c /usr/bin/longpath', env)).toBe(
      'a [redacted] b [redacted] c /usr/bin/longpath',
    );
  });

  it('masks GitHub-shaped tokens that are not in env', () => {
    expect(
      redactGitHubCredentials(
        'https://x-access-token:ghs_abc123DEF@github.com/o/r.git ghp_xyz gho_1 ghu_2 ghr_3 github_pat_11AB_cd',
        {},
      ),
    ).toBe(
      'https://x-access-token:[redacted]@github.com/o/r.git [redacted] [redacted] [redacted] [redacted] [redacted]',
    );
  });

  it('ignores empty, undefined and very short credential values', () => {
    expect(redactGitHubCredentials('1 abc', { GITHUB_TOKEN: '1', GH_TOKEN: undefined, GITHUB_PAT: '' })).toBe('1 abc');
  });

  it('defaults to process.env', () => {
    const prior = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'from-process-env-123';
    try {
      expect(redactGitHubCredentials('x from-process-env-123 y')).toBe('x [redacted] y');
    } finally {
      if (prior === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prior;
    }
  });
});

describe('redactExecError', () => {
  it('redacts message, stack, cmd, stdout and stderr in place', () => {
    const secret = 'super-secret-token';
    const err = Object.assign(new Error(`Command failed: git push https://${secret}@github.com`), {
      cmd: `git push https://${secret}@github.com`,
      stdout: `out ${secret}`,
      stderr: `err ${secret}`,
      code: 1,
    });

    const result = redactExecError(err, { GITHUB_TOKEN: secret });

    expect(result).toBe(err);
    for (const text of [err.message, err.stack, err.cmd, err.stdout, err.stderr]) {
      expect(text).not.toContain(secret);
      expect(text).toContain('[redacted]');
    }
    expect(err.code).toBe(1);
  });

  it('passes non-objects through untouched', () => {
    expect(redactExecError('plain string', { GITHUB_TOKEN: 'plain string' })).toBe('plain string');
    expect(redactExecError(null)).toBeNull();
  });
});
