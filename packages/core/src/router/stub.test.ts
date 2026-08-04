import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../models/index.js';
import { makeStubModelsConfig, makeStubRoutesConfig } from '../test-support/index.js';
import { StubModelExecutor } from './stub.js';

function ctx() {
  return {
    worktree: '/tmp/worktree',
    timeoutSeconds: 60,
    task: 'plan' as const,
    registry: new ModelRegistry(makeStubModelsConfig()),
    routesConfig: makeStubRoutesConfig(),
  };
}

describe('StubModelExecutor script exhaustion', () => {
  it('rejects with its own message, not the delegate SimModelExecutor message', async () => {
    const stub = new StubModelExecutor();

    await expect(stub.runModel('m', 'p', ctx())).rejects.toThrow(
      "StubModelExecutor: no scripted step or defaultOutput for task 'plan'",
    );
  });
});
