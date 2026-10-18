// #3126 — every harness turns its recorded CLI output into real, unestimated usage.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { CostEntry } from '../types/index.js';
import { parseResultEnvelope } from './claude-cli.js';
import { parseCodexUsage } from './codex-cli.js';
import { parseJsonlUsage } from './command.js';
import { parseOpenCodeJson } from './opencode.js';
import { parsePiJson } from './pi.js';
import type { HarnessUsage } from './index.js';

const PARSERS: [string, (stdout: string) => HarnessUsage | undefined][] = [
  ['claude-cli', (s) => parseResultEnvelope(s).usage],
  ['codex', parseCodexUsage],
  ['opencode', (s) => parseOpenCodeJson(s)?.usage],
  ['pi', (s) => parsePiJson(s)?.usage],
  ['command-agent', parseJsonlUsage],
];

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

describe('harness usage fixtures', () => {
  it.each(PARSERS)('%s recording parses into real usage and an unestimated cost row', async (dir, parse) => {
    const file = new URL(`../../../../scripts/fixtures/agents/recordings/${dir}/success.stdout`, import.meta.url);
    const usage = parse(readFileSync(fileURLToPath(file), 'utf8'));
    expect(usage).toBeDefined();
    if (!usage) return;
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);

    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: 'ok', effect: (ctx) => ctx.onUsage?.(usage) }] },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const rows: Omit<CostEntry, 'issue' | 'ts'>[] = [];
    router.setCostSink((entry) => rows.push(entry));
    await router.run('plan', 'do it');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.estimated).toBe(false);
    expect(rows[0]?.inputTokens).toBe(usage.inputTokens);
    expect(rows[0]?.outputTokens).toBe(usage.outputTokens);
  });
});
