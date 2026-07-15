import assert from 'node:assert/strict';
import { CodingHarness, HarnessError, HarnessRequest, HarnessFailureReason } from './index.js';
import { ModelRegistry } from '../models/index.js';
import type { ModelsConfig } from '../config/index.js';

const HARNESS_FAILURE_REASONS: HarnessFailureReason[] = [
  'rate_limit',
  'usage_cap',
  'timeout',
  'error',
  'empty_response',
  'unknown',
];

const CONTRACT_MODELS_CONFIG: ModelsConfig = {
  version: 1,
  models: {
    'contract-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['contract-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

export interface HarnessContractScenario {
  harness: CodingHarness;
  /** Optional overrides merged over the kit's default request. */
  request?: Partial<HarnessRequest>;
}

export interface HarnessContractScenarios {
  /** Must resolve with non-empty output. */
  success(): HarnessContractScenario;
  /** Must reject with HarnessError reason 'timeout'. */
  timeout(): HarnessContractScenario;
  /** Must reject with HarnessError reason 'empty_response'. */
  emptyOutput(): HarnessContractScenario;
  /** Must reject with a HarnessError carrying any valid classified reason. */
  failure(): HarnessContractScenario;
}

export interface HarnessContractCase {
  name: string;
  run(): Promise<void>;
}

/** Builds a default HarnessRequest against a minimal single-model registry.
 *  Real-harness suites (#184+) will need to point `model` at their own
 *  stubbed registry via `overrides`. */
export function makeContractRequest(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    model: 'contract-model',
    prompt: 'contract test prompt',
    worktree: '/tmp/contract-worktree',
    timeoutSeconds: 60,
    task: 'build_codex',
    registry: new ModelRegistry(CONTRACT_MODELS_CONFIG),
    ...overrides,
  };
}

async function expectHarnessError(
  scenario: HarnessContractScenario,
  check: (err: HarnessError) => void,
): Promise<void> {
  try {
    await scenario.harness.run(makeContractRequest(scenario.request));
    assert.fail('expected rejection');
  } catch (err) {
    assert.ok(err instanceof HarnessError);
    check(err);
  }
}

export function codingHarnessContractCases(scenarios: HarnessContractScenarios): HarnessContractCase[] {
  return [
    {
      name: 'resolves with non-empty output on success',
      async run() {
        const scenario = scenarios.success();
        const result = await scenario.harness.run(makeContractRequest(scenario.request));
        assert.equal(typeof result.output, 'string');
        assert.ok(result.output.trim().length > 0);
      },
    },
    {
      name: 'exposes a stable id and agentic capability',
      async run() {
        const { harness } = scenarios.success();
        assert.ok(harness.id.length > 0);
        assert.equal(typeof harness.agentic, 'boolean');
      },
    },
    {
      name: 'rejects with HarnessError reason timeout on timeout',
      async run() {
        await expectHarnessError(scenarios.timeout(), err => assert.equal(err.reason, 'timeout'));
      },
    },
    {
      name: 'rejects with HarnessError reason empty_response on empty output',
      async run() {
        await expectHarnessError(scenarios.emptyOutput(), err => assert.equal(err.reason, 'empty_response'));
      },
    },
    {
      name: 'rejects with a classified reason on nonzero failure',
      async run() {
        await expectHarnessError(scenarios.failure(), err => assert.ok(HARNESS_FAILURE_REASONS.includes(err.reason)));
      },
    },
    {
      name: 'failure rejections carry a non-empty diagnostic message',
      async run() {
        for (const scenario of [scenarios.timeout(), scenarios.emptyOutput(), scenarios.failure()]) {
          await expectHarnessError(scenario, err =>
            assert.ok(err.message.trim().length > 0, `harness rejected with an empty message (reason=${err.reason})`));
        }
      },
    },
  ];
}
