import { describe, expect, it } from 'vitest';

import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';
import { StubCodingHarness } from './stub.js';

describe('CodingHarness contract: StubCodingHarness', () => {
  const cases = codingHarnessContractCases({
    success: () => ({ harness: new StubCodingHarness([{ output: 'stub success output' }]) }),
    timeout: () => ({ harness: new StubCodingHarness([{ fail: 'timeout' }]) }),
    emptyOutput: () => ({ harness: new StubCodingHarness([{ output: '   ' }]) }),
    failure: () => ({ harness: new StubCodingHarness([{ fail: 'error' }]) }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

describe('StubCodingHarness', () => {
  it('records each request in calls', async () => {
    const harness = new StubCodingHarness([{ output: 'first' }, { output: 'second' }]);
    await harness.run(makeContractRequest({ prompt: 'prompt one', model: 'contract-model' }));
    await harness.run(makeContractRequest({ prompt: 'prompt two', model: 'contract-model' }));
    expect(harness.calls.length).toBe(2);
    expect(harness.calls[0].prompt).toBe('prompt one');
    expect(harness.calls[0].model).toBe('contract-model');
  });

  it('consumes scripted steps in order', async () => {
    const harness = new StubCodingHarness([{ output: 'first' }, { fail: 'rate_limit' }]);
    const first = await harness.run(makeContractRequest());
    expect(first.output).toBe('first');

    await expect(harness.run(makeContractRequest())).rejects.toMatchObject({
      reason: 'rate_limit',
    });
  });

  it('falls back to defaultOutput when steps are exhausted', async () => {
    const harness = new StubCodingHarness([], { defaultOutput: 'fallback output' });
    const result = await harness.run(makeContractRequest());
    expect(result.output).toBe('fallback output');
  });

  it('throws a plain error when no step and no defaultOutput remain', async () => {
    const harness = new StubCodingHarness([]);
    await expect(harness.run(makeContractRequest())).rejects.toThrow(/no scripted step/);
    await expect(harness.run(makeContractRequest())).rejects.not.toBeInstanceOf(HarnessError);
  });

  it('honors custom id/agentic options', () => {
    const harness = new StubCodingHarness([], { id: 'fake-ollama', agentic: false });
    expect(harness.id).toBe('fake-ollama');
    expect(harness.agentic).toBe(false);
  });
});
