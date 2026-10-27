import { describe, expect, it } from 'vitest';
import { CHECKER_ENV_ALLOWLIST, checkerParentEnv } from './checker-env.js';

describe('checkerParentEnv', () => {
  it('keeps allow-listed variables and drops secrets', () => {
    const kept = {
      PATH: '/bin',
      HOME: '/h',
      LANG: 'C',
      LC_ALL: 'C',
      TERM: 'x',
      CI: '1',
      NODE_OPTIONS: '--a',
      npm_config_cache: '/c',
    };
    const out = checkerParentEnv({
      ...kept,
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
      AWS_SECRET_ACCESS_KEY: 'c',
      GH_TOKEN: 'd',
      RANDOM_VAR: 'e',
    });
    expect(out).toEqual(kept);
  });

  it('drops credential-shaped npm_config_ names but keeps npm_config_registry', () => {
    const out = checkerParentEnv({
      npm_config__authToken: 'x',
      'npm_config_//registry.npmjs.org/:_authToken': 'y',
      npm_config_registry: 'https://r',
    });
    expect(out).toEqual({ npm_config_registry: 'https://r' });
  });

  it('matches case-insensitively', () => {
    const parent = { Path: '/bin', SystemRoot: 'C:\\W', https_proxy: 'http://p' };
    expect(checkerParentEnv(parent)).toEqual(parent);
  });

  it('passes names from FACTORY_CHECKER_ENV_ALLOW and not the variable itself', () => {
    const out = checkerParentEnv({
      FACTORY_CHECKER_ENV_ALLOW: ' JAVA_OPTS, ,MY_SDK ',
      JAVA_OPTS: '1',
      MY_SDK: '2',
      X: '3',
    });
    expect(out).toEqual({ JAVA_OPTS: '1', MY_SDK: '2' });
  });

  it('keeps the daemon groups file and FACTORY_HEADLESS=0', () => {
    const parent = { FACTORY_DAEMON_GROUPS_FILE: '/g', FACTORY_HEADLESS: '0' };
    expect(checkerParentEnv(parent)).toEqual(parent);
  });

  it('skips undefined values', () => {
    expect(checkerParentEnv({ PATH: undefined, HOME: '/h' })).toEqual({ HOME: '/h' });
  });

  it('lists no credential-shaped entry', () => {
    expect(CHECKER_ENV_ALLOWLIST.filter((e) => /KEY|TOKEN|SECRET|PASSWORD/i.test(e))).toEqual([]);
  });
});
