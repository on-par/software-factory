import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { OllamaAgenticHarness, OllamaAgenticExecFn, PATCH_PROPOSAL_SCHEMA } from './ollama-agentic.js';
import type { OllamaFetchFn } from './ollama-http.js';
import { HarnessError } from './index.js';
import { ModelRegistry } from '../models/index.js';
import type { ModelsConfig } from '../config/index.js';

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'local-agentic-model': {
      provider: 'ollama',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 32768,
      capabilities: [],
      envKey: null,
      harness: 'ollama-agentic',
      providerModel: 'qwen3.5:9b',
      providerOptions: { num_ctx: 8192 },
    },
  },
  tiers: { worker: ['local-agentic-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-agentic-'));
  tempDirs.push(dir);
  return dir;
}

function okChatResponse(content: string) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({ message: { content } }) };
}

function stubFetch(responses: string[]): OllamaFetchFn & { calls: any[] } {
  let i = 0;
  const calls: any[] = [];
  const fn = (async (input: string, init: any) => {
    calls.push({ input, init });
    return okChatResponse(responses[i++]);
  }) as OllamaFetchFn & { calls: any[] };
  fn.calls = calls;
  return fn;
}

const okExec: OllamaAgenticExecFn = async () => ({ stdout: '', stderr: '' });

function firstGreenProposal(): string {
  return JSON.stringify({
    summary: 'add first-green marker',
    changes: [{
      file: 'docs/local-small-first-green.md',
      find: '',
      replace: '# Local-Small First Green\n\nThis file is the canonical tiny success target for local-small factory runs.\n',
    }],
    verifyCommand: 'test -f docs/local-small-first-green.md',
  });
}

describe('CodingHarness contract: OllamaAgenticHarness', () => {
  const cases = codingHarnessContractCases({
    success: () => ({
      harness: new OllamaAgenticHarness(stubFetch([firstGreenProposal()]), okExec),
      request: { model: 'local-agentic-model', registry, worktree: makeWorktree() },
    }),
    timeout: () => ({
      harness: new OllamaAgenticHarness(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, okExec),
      request: { model: 'local-agentic-model', registry, worktree: makeWorktree() },
    }),
    emptyOutput: () => ({
      harness: new OllamaAgenticHarness(stubFetch(['', '']), okExec),
      request: { model: 'local-agentic-model', registry, worktree: makeWorktree() },
    }),
    failure: () => ({
      harness: new OllamaAgenticHarness(async () => ({
        ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'rate limit exceeded', json: async () => ({}),
      }), okExec),
      request: { model: 'local-agentic-model', registry, worktree: makeWorktree() },
    }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

describe('OllamaAgenticHarness first-green fixture', () => {
  it('applies the recorded proposal and records the expected request shape', async () => {
    const worktree = makeWorktree();
    const fetchFn = stubFetch([firstGreenProposal()]);
    const harness = new OllamaAgenticHarness(fetchFn, okExec);

    const result = await harness.run(makeContractRequest({ model: 'local-agentic-model', registry, worktree }));

    expect(result.output).toContain('docs/local-small-first-green.md');
    const written = await readFile(join(worktree, 'docs/local-small-first-green.md'), 'utf-8');
    expect(written).toBe('# Local-Small First Green\n\nThis file is the canonical tiny success target for local-small factory runs.\n');

    expect(fetchFn.calls).toHaveLength(1);
    const body = JSON.parse(fetchFn.calls[0].init.body);
    expect(body.format).toEqual(PATCH_PROPOSAL_SCHEMA);
    expect(body.model).toBe('qwen3.5:9b');
    expect(body.stream).toBe(false);
    expect(body.options.num_ctx).toBe(8192);
  });
});

describe('OllamaAgenticHarness repair', () => {
  it('recovers from invalid JSON on the first attempt', async () => {
    const worktree = makeWorktree();
    const fetchFn = stubFetch(['not json at all', firstGreenProposal()]);
    const harness = new OllamaAgenticHarness(fetchFn, okExec);

    const result = await harness.run(makeContractRequest({ model: 'local-agentic-model', registry, worktree }));

    expect(result.output).toContain('docs/local-small-first-green.md');
    expect(existsSync(join(worktree, 'docs/local-small-first-green.md'))).toBe(true);
    expect(fetchFn.calls).toHaveLength(2);
    const secondPrompt = JSON.parse(fetchFn.calls[1].init.body).messages[0].content;
    expect(secondPrompt).toContain('invalid_json');
  });
});

describe('OllamaAgenticHarness malformed output after repair', () => {
  it('writes an auditable trace and rejects with a classified reason', async () => {
    const worktree = makeWorktree();
    const fetchFn = stubFetch(['not json', 'still not json']);
    const harness = new OllamaAgenticHarness(fetchFn, okExec);

    const err: any = await harness.run(makeContractRequest({ model: 'local-agentic-model', registry, worktree })).catch(e => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('error');
    expect(err.message).toMatch(/trace written to/);

    const tracePath = err.message.match(/trace written to (.+)$/)[1];
    expect(tracePath).toContain(join(worktree, '.factory', 'local-agent-traces'));
    const trace = JSON.parse(await readFile(tracePath, 'utf-8'));
    expect(trace.harness).toBe('ollama-agentic');
    expect(trace.malformedReason).toBe('invalid_json');
    expect(trace.rawResponseSummary.length).toBeGreaterThan(0);
  });
});

describe('OllamaAgenticHarness unsafe paths', () => {
  it('rejects a proposal that escapes the worktree without writing outside it', async () => {
    const parent = makeWorktree();
    const worktree = join(parent, 'nested');
    await mkdir(worktree, { recursive: true });

    const escapeProposal = JSON.stringify({
      summary: 'escape',
      changes: [{ file: '../escape.md', find: '', replace: 'pwned' }],
      verifyCommand: 'true',
    });
    const fetchFn = stubFetch([escapeProposal, escapeProposal]);
    const harness = new OllamaAgenticHarness(fetchFn, okExec);

    const err: any = await harness.run(makeContractRequest({ model: 'local-agentic-model', registry, worktree })).catch(e => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('schema_invalid');
    const tracePath = err.message.match(/trace written to (.+)$/)[1];
    const trace = JSON.parse(await readFile(tracePath, 'utf-8'));
    expect(trace.malformedReason).toBe('schema_invalid');
    expect(existsSync(join(parent, 'escape.md'))).toBe(false);
  });
});

describe('OllamaAgenticHarness apply failures', () => {
  it('repairs then fails when the find text is never present, leaving the file unchanged', async () => {
    const worktree = makeWorktree();
    const targetPath = join(worktree, 'src', 'file.txt');
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, 'original content\n');

    const badProposal = JSON.stringify({
      summary: 'change it',
      changes: [{ file: 'src/file.txt', find: 'text that is not present', replace: 'new content' }],
      verifyCommand: 'true',
    });
    const fetchFn = stubFetch([badProposal, badProposal]);
    const harness = new OllamaAgenticHarness(fetchFn, okExec);

    const err: any = await harness.run(makeContractRequest({ model: 'local-agentic-model', registry, worktree })).catch(e => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('apply_failed');
    const tracePath = err.message.match(/trace written to (.+)$/)[1];
    const trace = JSON.parse(await readFile(tracePath, 'utf-8'));
    expect(trace.malformedReason).toBe('apply_failed');
    expect(await readFile(targetPath, 'utf-8')).toBe('original content\n');
  });
});

describe('OllamaAgenticHarness verify failures', () => {
  it('rejects with a classified reason and no repair attempt', async () => {
    const worktree = makeWorktree();
    const fetchFn = stubFetch([firstGreenProposal()]);
    const failingExec: OllamaAgenticExecFn = async () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'FAIL' });
    };
    const harness = new OllamaAgenticHarness(fetchFn, failingExec);

    const err: any = await harness.run(makeContractRequest({ model: 'local-agentic-model', registry, worktree })).catch(e => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('verify_failed');
    expect(err.message).toMatch(/verify failed/);
    expect(fetchFn.calls).toHaveLength(1);

    const tracePath = err.message.match(/trace written to (.+)$/)[1];
    const trace = JSON.parse(await readFile(tracePath, 'utf-8'));
    expect(trace.malformedReason).toBe('verify_failed');
  });
});
