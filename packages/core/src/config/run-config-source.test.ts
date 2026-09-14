import { afterEach, expect, it, vi } from 'vitest';

import { loadRepoConfig } from './repo.js';

afterEach(() => vi.unstubAllEnvs());

it('starts each test suite without the parent daemon configuration', () => {
  expect(process.env.FACTORY_RUN_CONFIG_JSON).toBeUndefined();
});

it('still lets a test explicitly supply a daemon configuration to the real loader', () => {
  vi.stubEnv('FACTORY_RUN_CONFIG_JSON', JSON.stringify({ version: 2, route: 'codex' }));

  expect(loadRepoConfig('/unused-checkout')).toMatchObject({ version: 2, route: 'codex' });
});
