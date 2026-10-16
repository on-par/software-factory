import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { makeContractRequest } from '../harness/contract.js';
import { OpenCodeHarness } from '../harness/opencode.js';
import { diagnoseModels, ModelRegistry } from '../models/index.js';
import { localAuthFailureSinceLogin, localAuthRecordPath, recordLocalAuthFailure } from '../utils/local-auth-record.js';
import { ModelRouter } from './index.js';

const config: ModelsConfig = {
  version: 1,
  models: {
    'oc-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
    },
  },
  tiers: { boss: ['oc-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

const fixture = readFileSync(
  fileURLToPath(new URL('../__fixtures__/opencode/error-typed-auth.jsonl', import.meta.url)),
  'utf8',
);

describe('opencode 401 fixture → harness → router → record → models doctor (#3030)', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let authJson: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'oc-auth-'));
    env = { XDG_DATA_HOME: join(home, 'data') };
    authJson = join(home, 'data', 'opencode', 'auth.json');
    mkdirSync(dirname(authJson), { recursive: true });
    writeFileSync(authJson, '{}');
    const past = Date.UTC(2026, 9, 1) / 1000;
    utimesSync(authJson, past, past);

    const exec = async (cmd: string) => {
      if (cmd === 'opencode --version') return { stdout: '', stderr: '' };
      throw Object.assign(new Error('boom'), { code: 1, stderr: '', stdout: fixture });
    };
    const harness = new OpenCodeHarness(exec as any);
    const router = new ModelRouter(config, routes, false, {
      runModel: async () => (await harness.run(makeContractRequest())) as any,
    });
    router.setLocalAuthSink((a) =>
      recordLocalAuthFailure(a, { homedir: () => home, env, now: () => Date.UTC(2026, 9, 14, 9) }),
    );
    await expect(router.run('plan', 'plan')).rejects.toBeDefined();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('records an opencode local_auth failure from the 401 fixture into local-auth-failures.json', () => {
    const record = JSON.parse(readFileSync(localAuthRecordPath({ homedir: () => home }), 'utf8'));
    expect(record).toEqual({ opencode: { agent: 'opencode', at: '2026-10-14T09:00:00.000Z' } });
  });

  it('reports it through models doctor with the re-auth command until a new login', () => {
    const deps = { homedir: () => home, env };
    expect(localAuthFailureSinceLogin('opencode', deps)).toEqual({
      agent: 'opencode',
      at: '2026-10-14T09:00:00.000Z',
    });
    const [d] = diagnoseModels(
      new ModelRegistry(config),
      {
        commandAvailable: (c) => c === 'opencode',
        envPresent: () => false,
        opencodeLoggedIn: () => true,
        localAuthFailure: (a) => localAuthFailureSinceLogin(a, deps),
      },
      true,
    );
    expect(d!.reachable).toBe(false);
    expect(d!.reason).toContain('re-run opencode auth login');

    const after = Date.UTC(2026, 9, 15) / 1000;
    utimesSync(authJson, after, after);
    expect(localAuthFailureSinceLogin('opencode', deps)).toBeNull();
  });
});
