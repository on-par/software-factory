import { describe, expect, it } from 'vitest';

import { GitHubConfigSchema } from './github-section.js';
import { resolveGitHubCredentialsConfig } from './index.js';

const parse = (github: unknown) => GitHubConfigSchema.safeParse(github);

describe('github.credentials config', () => {
  it('defaults to no ambient opt-in and no app', () => {
    const config = GitHubConfigSchema.parse(undefined);
    expect(config).toEqual({ credentials: { allowAmbientToken: false } });
    expect(resolveGitHubCredentialsConfig({ github: config })).toEqual({ allowAmbientToken: false });
  });

  it('parses the app ids and the ambient opt-in', () => {
    const github = GitHubConfigSchema.parse({
      credentials: { allowAmbientToken: true, app: { appId: 12, installationId: 34 } },
    });
    expect(resolveGitHubCredentialsConfig({ github })).toEqual({
      allowAmbientToken: true,
      app: { appId: 12, installationId: 34 },
    });
  });

  it('rejects non-integer and non-positive ids', () => {
    for (const app of [
      { appId: 1.5, installationId: 2 },
      { appId: 1, installationId: 0 },
      { appId: '1', installationId: 2 },
    ]) {
      expect(parse({ credentials: { app } }).success).toBe(false);
    }
  });

  it('rejects a private key in config', () => {
    const parsed = parse({ credentials: { app: { appId: 1, installationId: 2, privateKey: 'pem' } } });
    expect(parsed.success).toBe(false);
  });

  it('resolves a hand-built config with no github section', () => {
    expect(resolveGitHubCredentialsConfig({})).toEqual({ allowAmbientToken: false });
  });
});
