import { describe, expect, it } from 'vitest';

import { githubCredentialSourceCheck } from './doctor-github-credentials.js';

const github = (credentials: Record<string, unknown>) =>
  ({ github: { credentials: { allowAmbientToken: false, ...credentials } } }) as Parameters<
    typeof githubCredentialSourceCheck
  >[0];

describe('githubCredentialSourceCheck', () => {
  it('warns when the ambient token opt-in is set', () => {
    expect(githubCredentialSourceCheck(github({ allowAmbientToken: true }), {})).toEqual({
      name: 'GitHub credential source',
      ok: false,
      optional: true,
      detail: 'ambient operator token in use (github.credentials.allowAmbientToken)',
      fix: expect.stringContaining('docs/ops/github-credentials.md'),
    });
  });

  it('warns that the ambient token is used without opt-in', () => {
    const check = githubCredentialSourceCheck({}, {});
    expect(check).toMatchObject({ ok: false, optional: true });
    expect(check.detail).toContain('ADR-0160');
    expect(check.fix).toContain('github.credentials.app');
  });

  it('reports the app installation source as ok', () => {
    const check = githubCredentialSourceCheck(github({ app: { appId: 1, installationId: 2 } }), {
      FACTORY_GITHUB_APP_PRIVATE_KEY: 'pem',
    });
    expect(check).toMatchObject({ ok: true });
    expect(check.detail).toContain('GitHub App');
  });

  it('reports fine-grained tokens as ok', () => {
    const check = githubCredentialSourceCheck({}, { FACTORY_GITHUB_TOKEN_SHIP: 'github_pat_x' });
    expect(check).toMatchObject({ ok: true });
    expect(check.detail).toContain('fine-grained');
  });
});
