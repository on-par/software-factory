import { afterEach, describe, expect, it, vi } from 'vitest';
import { runVerificationCommand, VERIFICATION_SCRUBBED_ENV_VARS } from './run-command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runVerificationCommand', () => {
  it("removes the supervisor's merge flags inherited from the factory process and from options.env", async () => {
    vi.stubEnv('FACTORY_MERGE_ADMIN', '1');
    vi.stubEnv('FACTORY_MERGE', '1');
    vi.stubEnv('FACTORY_LOCAL_ONLY', '1');
    vi.stubEnv('FACTORY_SKIP_CI', '1');
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', '{}');
    vi.stubEnv('FACTORY_RUN_CONFIG_ORIGIN', '/src/.factory/config.yaml');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy:1');
    vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=2048');

    const result = await runVerificationCommand(
      [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: { FACTORY_SKIP_CI: '1', HTTP_PROXY: 'http://cfg:2', FACTORY_APP_PORT: '3142' } },
    );

    const env = JSON.parse(result.stdout) as Record<string, string | undefined>;
    for (const name of VERIFICATION_SCRUBBED_ENV_VARS) expect(env[name]).toBeUndefined();
    expect(env.PATH).toBeTruthy();
    expect(env.HTTPS_PROXY).toBe('http://proxy:1');
    expect(env.HTTP_PROXY).toBe('http://cfg:2');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=2048');
    expect(env.FACTORY_APP_PORT).toBe('3142');
    expect(process.env.FACTORY_MERGE_ADMIN).toBe('1');
  });

  it('scrubs exactly the run-config snapshot, its origin and the four merge flags', () => {
    expect([...VERIFICATION_SCRUBBED_ENV_VARS].sort()).toEqual(
      [
        'FACTORY_LOCAL_ONLY',
        'FACTORY_MERGE',
        'FACTORY_MERGE_ADMIN',
        'FACTORY_RUN_CONFIG_JSON',
        'FACTORY_RUN_CONFIG_ORIGIN',
        'FACTORY_SKIP_CI',
      ].sort(),
    );
  });
});
