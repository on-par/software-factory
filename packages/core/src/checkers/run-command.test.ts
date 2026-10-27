import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { laneEnv } from '../environment/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { testsChecker } from './index.js';
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

describe('checker env allow-list (#1590)', () => {
  const dirs = createTempDirs();
  afterEach(() => dirs.cleanup());

  async function runDump(): Promise<string> {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret-value');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-secret-value');
    vi.stubEnv('GH_TOKEN', 'ghp_secret_token_value');
    const worktree = await dirs.make('checker-env-');
    await mkdir(join(worktree, 'scripts'));
    await writeFile(
      join(worktree, 'scripts', 'verify.sh'),
      '#!/usr/bin/env bash\nfor v in ANTHROPIC_API_KEY OPENAI_API_KEY GH_TOKEN PORT FACTORY_BASE_URL FACTORY_HEADLESS; do echo "$v=${!v-<unset>}"; done; exit 1\n',
      { mode: 0o755 },
    );
    const result = await testsChecker({
      worktree,
      specPath: 'none',
      constitutionBody: 'x',
      env: laneEnv(4123, {}),
    });
    return result.details;
  }

  it('tests checker command does not see ANTHROPIC_API_KEY, OPENAI_API_KEY or GH_TOKEN from the factory process', async () => {
    const details = await runDump();
    expect(details).toContain('ANTHROPIC_API_KEY=<unset>');
    expect(details).toContain('OPENAI_API_KEY=<unset>');
    expect(details).toContain('GH_TOKEN=<unset>');
  });

  it('tests checker command sees the lane PORT, FACTORY_BASE_URL and FACTORY_HEADLESS but no host secret', async () => {
    const details = await runDump();
    expect(details).toContain('PORT=4123');
    expect(details).toContain('FACTORY_BASE_URL=http://127.0.0.1:4123');
    expect(details).toContain('FACTORY_HEADLESS=1');
    expect(details).toContain('ANTHROPIC_API_KEY=<unset>');
  });

  it('runVerificationCommand filters an explicit parentEnv', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret-value');
    const result = await runVerificationCommand(
      [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { parentEnv: { PATH: process.env.PATH, AWS_SECRET_ACCESS_KEY: 'zzz', HOME: '/h' } },
    );
    const env = JSON.parse(result.stdout) as Record<string, string | undefined>;
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBe('/h');
  });
});
