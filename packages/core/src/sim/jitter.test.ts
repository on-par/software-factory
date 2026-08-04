import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import type { ModelExecutor, ModelExecutorContext } from '../router/index.js';
import { makeStubModelsConfig, makeStubRoutesConfig } from '../test-support/index.js';
import { createSimOctokit } from './octokit.js';
import {
  createSeededRandom,
  deriveSimSeed,
  SIM_FAILURE_MODES,
  SIM_MALFORMED_OUTPUT,
  SimJitter,
  SimJitterExecutor,
  type SimJitterConfig,
  withSimJitter,
} from './jitter.js';
import type { SimClock } from './latency.js';

function recordingClock(random = 0.5): SimClock & { slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => random,
  };
}

const CTX: ModelExecutorContext = {
  worktree: '/tmp/worktree',
  timeoutSeconds: 60,
  task: 'plan',
  registry: new ModelRegistry(makeStubModelsConfig()),
  routesConfig: makeStubRoutesConfig(),
};

describe('createSeededRandom', () => {
  it('same seed produces identical sequences', () => {
    const a = createSeededRandom(12345);
    const b = createSeededRandom(12345);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different sequences', () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('every value is in [0, 1) over 1000 draws', () => {
    const rand = createSeededRandom(7);
    for (let i = 0; i < 1000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('deriveSimSeed', () => {
  it('is deterministic for the same (seed, issue)', () => {
    expect(deriveSimSeed(42, 100)).toBe(deriveSimSeed(42, 100));
  });

  it('differs across issues', () => {
    expect(deriveSimSeed(42, 100)).not.toBe(deriveSimSeed(42, 101));
  });

  it('returns a uint32', () => {
    const seed = deriveSimSeed(42, 100);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('SimJitter', () => {
  it('two instances with the same seed and config produce deep-equal draws (AC1, unit level)', () => {
    const config: SimJitterConfig = {
      seed: 999,
      default: { delay: { minMs: 1, maxMs: 10 }, failureRate: 0.5 },
    };
    const a = new SimJitter(config);
    const b = new SimJitter(config);
    for (let i = 0; i < 200; i++) {
      const phase = i % 2 === 0 ? 'build' : 'ship';
      const seam = i % 2 === 0 ? 'model' : 'github';
      a.next(phase, seam);
      b.next(phase, seam);
    }
    expect(a.draws).toEqual(b.draws);
  });

  it('failureRate: 1 fails every draw; failureRate: 0 fails none', () => {
    const failing = new SimJitter({ seed: 1, default: { failureRate: 1 } });
    for (let i = 0; i < 50; i++) {
      expect(failing.next('build', 'model').failure).not.toBeNull();
    }

    const passing = new SimJitter({ seed: 1, default: { failureRate: 0 } });
    for (let i = 0; i < 50; i++) {
      expect(passing.next('build', 'model').failure).toBeNull();
    }

    const absent = new SimJitter({ seed: 1 });
    for (let i = 0; i < 50; i++) {
      expect(absent.next('build', 'model').failure).toBeNull();
    }
  });

  it('clamps failureRate: 2 to 1 and -1 to 0', () => {
    const over = new SimJitter({ seed: 3, default: { failureRate: 2 } });
    for (let i = 0; i < 50; i++) {
      expect(over.next('build', 'model').failure).not.toBeNull();
    }

    const under = new SimJitter({ seed: 3, default: { failureRate: -1 } });
    for (let i = 0; i < 50; i++) {
      expect(under.next('build', 'model').failure).toBeNull();
    }
  });

  it('a per-phase entry wins over default; a phase with no entry falls back to default', () => {
    const jitter = new SimJitter({
      seed: 5,
      default: { failureRate: 0 },
      phases: { build: { failureRate: 1 } },
    });
    expect(jitter.next('build', 'model').failure).not.toBeNull();
    expect(jitter.next('check', 'model').failure).toBeNull();
  });

  it('with neither phases nor default present, draws are { delayMs: 0, failure: null }', () => {
    const jitter = new SimJitter({ seed: 5 });
    expect(jitter.next('plan', 'model')).toEqual({ phase: 'plan', seam: 'model', delayMs: 0, failure: null });
  });

  it('failureModes restricts selection; empty array falls back to all SIM_FAILURE_MODES', () => {
    const restricted = new SimJitter({ seed: 8, default: { failureRate: 1, failureModes: ['timeout'] } });
    for (let i = 0; i < 200; i++) {
      expect(restricted.next('build', 'model').failure).toBe('timeout');
    }

    const fallback = new SimJitter({ seed: 8, default: { failureRate: 1, failureModes: [] } });
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const failure = fallback.next('build', 'model').failure;
      expect(failure).not.toBeNull();
      seen.add(failure as string);
    }
    for (const mode of seen) {
      expect(SIM_FAILURE_MODES).toContain(mode);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('fixed draw width: same seed and delay config, different failureRate, yields the identical delayMs sequence', () => {
    const low = new SimJitter({ seed: 42, default: { delay: { minMs: 5, maxMs: 50 }, failureRate: 0 } });
    const high = new SimJitter({ seed: 42, default: { delay: { minMs: 5, maxMs: 50 }, failureRate: 1 } });
    const lowDelays = Array.from({ length: 30 }, () => low.next('build', 'model').delayMs);
    const highDelays = Array.from({ length: 30 }, () => high.next('build', 'model').delayMs);
    expect(lowDelays).toEqual(highDelays);
  });

  it('delay resolves within [minMs, maxMs]', () => {
    const jitter = new SimJitter({ seed: 11, default: { delay: { minMs: 10, maxMs: 20 } } });
    for (let i = 0; i < 100; i++) {
      const { delayMs } = jitter.next('build', 'model');
      expect(delayMs).toBeGreaterThanOrEqual(10);
      expect(delayMs).toBeLessThanOrEqual(20);
    }
  });

  it('records phase and seam exactly as passed', () => {
    const jitter = new SimJitter({ seed: 1 });
    const draw = jitter.next('check', 'github');
    expect(draw.phase).toBe('check');
    expect(draw.seam).toBe('github');
  });
});

describe('SimJitterExecutor', () => {
  function recordingExecutor(): ModelExecutor & { calls: number } {
    return {
      calls: 0,
      async runModel(_model, _prompt, _ctx) {
        this.calls++;
        return 'inner output';
      },
    };
  }

  it('no failure delegates to inner, returns inner output, and sleeps the drawn ms once', async () => {
    const jitter = new SimJitter({ seed: 1, default: { delay: { fixedMs: 30 }, failureRate: 0 } });
    const inner = recordingExecutor();
    const clock = recordingClock();
    const executor = new SimJitterExecutor(inner, jitter, () => 'build', clock);
    const result = await executor.runModel('stub-model', 'prompt', CTX);
    expect(result).toBe('inner output');
    expect(inner.calls).toBe(1);
    expect(clock.slept).toEqual([30]);
  });

  it('does not sleep when delayMs is 0', async () => {
    const jitter = new SimJitter({ seed: 1, default: { failureRate: 0 } });
    const inner = recordingExecutor();
    const clock = recordingClock();
    const executor = new SimJitterExecutor(inner, jitter, () => 'build', clock);
    await executor.runModel('stub-model', 'prompt', CTX);
    expect(clock.slept).toEqual([]);
  });

  it("failureModes: ['timeout'] rejects with a ModelExecutorError whose reason is 'timeout'", async () => {
    const jitter = new SimJitter({ seed: 1, default: { failureRate: 1, failureModes: ['timeout'] } });
    const inner = recordingExecutor();
    const executor = new SimJitterExecutor(inner, jitter, () => 'build', recordingClock());
    await expect(executor.runModel('stub-model', 'prompt', CTX)).rejects.toMatchObject({
      reason: 'timeout',
    });
    expect(inner.calls).toBe(0);
  });

  it("failureModes: ['rate_limit'] rejects with reason 'rate_limit'", async () => {
    const jitter = new SimJitter({ seed: 1, default: { failureRate: 1, failureModes: ['rate_limit'] } });
    const inner = recordingExecutor();
    const executor = new SimJitterExecutor(inner, jitter, () => 'build', recordingClock());
    await expect(executor.runModel('stub-model', 'prompt', CTX)).rejects.toMatchObject({
      reason: 'rate_limit',
    });
    expect(inner.calls).toBe(0);
  });

  it("failureModes: ['network_error'] rejects with reason 'unavailable'", async () => {
    const jitter = new SimJitter({ seed: 1, default: { failureRate: 1, failureModes: ['network_error'] } });
    const inner = recordingExecutor();
    const executor = new SimJitterExecutor(inner, jitter, () => 'build', recordingClock());
    await expect(executor.runModel('stub-model', 'prompt', CTX)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(inner.calls).toBe(0);
  });

  it("'malformed_output' resolves SIM_MALFORMED_OUTPUT and inner is never called", async () => {
    const jitter = new SimJitter({ seed: 1, default: { failureRate: 1, failureModes: ['malformed_output'] } });
    const inner = recordingExecutor();
    const executor = new SimJitterExecutor(inner, jitter, () => 'build', recordingClock());
    const result = await executor.runModel('stub-model', 'prompt', CTX);
    expect(result).toBe(SIM_MALFORMED_OUTPUT);
    expect(result.length).toBeGreaterThan(0);
    expect(inner.calls).toBe(0);
  });

  it('phaseOf is consulted per call: flipping phase changes the recorded draw phase', async () => {
    const jitter = new SimJitter({ seed: 1, default: { failureRate: 0 } });
    const inner = recordingExecutor();
    let phase: 'plan' | 'build' = 'plan';
    const executor = new SimJitterExecutor(inner, jitter, () => phase, recordingClock());
    await executor.runModel('stub-model', 'prompt', CTX);
    phase = 'build';
    await executor.runModel('stub-model', 'prompt', CTX);
    expect(jitter.draws[0]?.phase).toBe('plan');
    expect(jitter.draws[1]?.phase).toBe('build');
    expect(jitter.draws[0]?.phase).not.toBe(jitter.draws[1]?.phase);
  });
});

describe('withSimJitter', () => {
  it('no failure resolves the underlying response and the underlying client records the call', async () => {
    const jitter = new SimJitter({ seed: 1, default: { failureRate: 0 } });
    const { octokit, calls } = createSimOctokit({ titles: { 1: 'Title' } });
    const wrapped = withSimJitter(octokit, jitter, () => 'plan', recordingClock());

    const issue = await wrapped.rest.issues.get({ issue_number: 1 });
    expect(issue.data.title).toBe('Title');

    await wrapped.rest.pulls.list({});
    await wrapped.rest.pulls.create({});
    await wrapped.rest.pulls.get({ pull_number: 101 });
    await wrapped.rest.checks.listForRef({});
    await wrapped.graphql('query', {});

    expect(calls.length).toBe(6);
  });

  it.each(SIM_FAILURE_MODES)('rate 1 with mode %s rejects and the underlying client records nothing', async (mode) => {
    const jitter = new SimJitter({ seed: 1, default: { failureRate: 1, failureModes: [mode] } });
    const { octokit, calls } = createSimOctokit({ titles: { 1: 'Title' } });
    const wrapped = withSimJitter(octokit, jitter, () => 'plan', recordingClock());

    await expect(wrapped.rest.issues.get({ issue_number: 1 })).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it('sleeps the drawn delay once per call via the injected clock', async () => {
    const jitter = new SimJitter({ seed: 1, default: { delay: { fixedMs: 15 }, failureRate: 0 } });
    const { octokit } = createSimOctokit({ titles: { 1: 'Title' } });
    const clock = recordingClock();
    const wrapped = withSimJitter(octokit, jitter, () => 'plan', clock);

    await wrapped.rest.issues.get({ issue_number: 1 });
    expect(clock.slept).toEqual([15]);
  });
});
