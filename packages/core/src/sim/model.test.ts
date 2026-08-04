import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { ModelExecutorError } from '../router/executor-error.js';
import { ModelRouter } from '../router/index.js';
import { makeStubModelsConfig, makeStubRoutesConfig, specContentFor } from '../test-support/index.js';
import { realSimClock, type SimClock } from './latency.js';
import { failOnCall, SimModelExecutor } from './model.js';

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

describe('SimModelExecutor', () => {
  it('AC1: a configured response flows through ModelRouter with no CLI spawn', async () => {
    const sim = new SimModelExecutor({ scripts: { plan: [{ output: specContentFor(34) }] } });
    const router = new ModelRouter(makeStubModelsConfig(), makeStubRoutesConfig(), false, sim);

    const result = await router.run('plan', 'do it');

    expect(result.output).toBe(specContentFor(34));
    expect(sim.calls).toHaveLength(1);
    expect(sim.calls[0]?.task).toBe('plan');
  });

  it('AC2: fixed latency (executor default) is applied and recorded', async () => {
    const clock = recordingClock();
    const sim = new SimModelExecutor({
      scripts: { plan: [{ output: 'ok' }] },
      latency: { fixedMs: 40 },
      clock,
    });

    await sim.runModel('m', 'p', ctx('plan'));

    expect(clock.slept).toEqual([40]);
    expect(sim.calls[0]?.latencyMs).toBe(40);
  });

  it('AC2: a per-step latency overrides the executor default', async () => {
    const clock = recordingClock();
    const sim = new SimModelExecutor({
      scripts: { plan: [{ output: 'ok', latency: { fixedMs: 10 } }] },
      latency: { fixedMs: 40 },
      clock,
    });

    await sim.runModel('m', 'p', ctx('plan'));

    expect(clock.slept).toEqual([10]);
    expect(sim.calls[0]?.latencyMs).toBe(10);
  });

  it('AC2: real-clock latency actually delays resolution', async () => {
    const sim = new SimModelExecutor({ scripts: { plan: [{ output: 'ok' }] }, latency: 25, clock: realSimClock });

    const start = performance.now();
    await sim.runModel('m', 'p', ctx('plan'));

    expect(performance.now() - start).toBeGreaterThanOrEqual(20);
  });

  it('AC3: failOnCall lets the first N-1 calls resolve and the Nth reject', async () => {
    const sim = new SimModelExecutor({
      scripts: { plan: failOnCall(3, 'rate_limit', { output: 'ok', message: 'boom' }) },
    });

    await expect(sim.runModel('m', 'p', ctx('plan'))).resolves.toBe('ok');
    await expect(sim.runModel('m', 'p', ctx('plan'))).resolves.toBe('ok');

    let error: unknown;
    try {
      await sim.runModel('m', 'p', ctx('plan'));
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ModelExecutorError);
    const modelError = error as ModelExecutorError;
    expect(modelError.message).toBe('boom');
    expect(modelError.reason).toBe('rate_limit');
    expect(modelError.details.exitCode).toBe(1);
    expect(sim.calls.map((call) => call.failed)).toEqual([false, false, true]);
  });

  it('AC3: failOnCall without a message defaults to "sim failure: <reason>"', async () => {
    const sim = new SimModelExecutor({ scripts: { plan: failOnCall(1, 'rate_limit') } });

    await expect(sim.runModel('m', 'p', ctx('plan'))).rejects.toMatchObject({
      message: 'sim failure: rate_limit',
      reason: 'rate_limit',
    });
  });

  it('resolves a distributed latency and records it', async () => {
    const clock = recordingClock(0.5);
    const sim = new SimModelExecutor({
      scripts: { plan: [{ output: 'ok', latency: { minMs: 10, maxMs: 20 } }] },
      clock,
    });

    await sim.runModel('m', 'p', ctx('plan'));

    expect(sim.calls[0]?.latencyMs).toBe(15);
  });

  it('runs effect after the delay and before resolving', async () => {
    const clock = recordingClock();
    const order: string[] = [];
    const sim = new SimModelExecutor({
      scripts: {
        plan: [
          {
            output: 'ok',
            latency: 10,
            effect: () => {
              order.push('effect');
            },
          },
        ],
      },
      clock: {
        ...clock,
        sleep: async (ms) => {
          order.push('sleep');
          await clock.sleep(ms);
        },
      },
    });

    await sim.runModel('m', 'p', ctx('plan'));

    expect(order).toEqual(['sleep', 'effect']);
  });

  it('runs effect after the delay and before rejecting on a failing step', async () => {
    const order: string[] = [];
    const clock = recordingClock();
    const sim = new SimModelExecutor({
      scripts: {
        plan: [
          {
            fail: 'error',
            latency: 10,
            effect: () => {
              order.push('effect');
            },
          },
        ],
      },
      clock: {
        ...clock,
        sleep: async (ms) => {
          order.push('sleep');
          await clock.sleep(ms);
        },
      },
    });

    await expect(sim.runModel('m', 'p', ctx('plan'))).rejects.toThrow();
    expect(order).toEqual(['sleep', 'effect']);
  });

  it('falls back to defaultStep once the script is drained', async () => {
    const sim = new SimModelExecutor({
      scripts: { plan: [{ output: 'first' }] },
      defaultStep: { output: 'fallback' },
    });

    await expect(sim.runModel('m', 'p', ctx('plan'))).resolves.toBe('first');
    await expect(sim.runModel('m', 'p', ctx('plan'))).resolves.toBe('fallback');
    await expect(sim.runModel('m', 'p', ctx('plan'))).resolves.toBe('fallback');
  });

  it('rejects with the script-exhaustion message and records a failed call when there is no default', async () => {
    const sim = new SimModelExecutor();

    await expect(sim.runModel('m', 'p', ctx('plan'))).rejects.toThrow(
      "SimModelExecutor: no scripted step or defaultStep for task 'plan'",
    );
    expect(sim.calls).toEqual([{ model: 'm', prompt: 'p', task: 'plan', latencyMs: 0, failed: true }]);
  });

  it('does not mutate the caller-provided scripts array', async () => {
    const original = [{ output: 'a' }, { output: 'b' }];
    const sim = new SimModelExecutor({ scripts: { plan: original } });

    await sim.runModel('m', 'p', ctx('plan'));
    await sim.runModel('m', 'p', ctx('plan'));

    expect(original).toHaveLength(2);
  });
});

function ctx(task: 'plan'): Parameters<SimModelExecutor['runModel']>[2] {
  return {
    worktree: '/tmp/worktree',
    timeoutSeconds: 60,
    task,
    registry: new ModelRegistry(makeStubModelsConfig()),
    routesConfig: makeStubRoutesConfig(),
  };
}
