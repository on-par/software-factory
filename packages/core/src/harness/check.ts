// src/harness/check.ts — run the harness contract kit against a user-declared `harnesses:` entry (#2875).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HarnessDeclaration } from '../config/index.js';
import type { ModelRegistry } from '../models/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { CommandHarness } from './command.js';
import type { HarnessContractScenarios } from './contract.js';
import { codingHarnessContractCases } from './contract.js';
import { HarnessError } from './index.js';

export interface HarnessCheckOptions {
  id: string;
  declaration: HarnessDeclaration;
  /** Registry model id, resolved through registry.getProviderModel by CommandHarness. */
  model: string;
  registry: ModelRegistry;
  execFn?: ExecFn;
}

export interface HarnessCheckResult {
  name: string;
  ok: boolean;
  rule: string;
  fix: string;
  error?: string;
}

const PROBE_PROMPT = 'Reply with the single word ok. Do not edit any files.';
const FAILURE_COMMAND = `sh -c 'echo "rate limit" >&2; exit 1'`;
const INJECTION_PREFIX = 'handles injected instruction without following it:';

const FALLBACK = {
  rule: 'docs/harness-contract.md',
  fix: 'See docs/harness-contract.md for this case.',
};

export const HARNESS_CHECK_RULES: Record<string, { rule: string; fix: string }> = {
  'resolves with non-empty output on success': {
    rule: 'non-empty output (docs/harness-contract.md#outputs-harnessresult)',
    fix: 'Make the CLI print its final answer and set `output:` to where it writes it (stdout, jsonl, or file:{outFile}).',
  },
  'exposes a stable id and agentic capability': {
    rule: 'stable id and agentic flag (docs/harness-contract.md#the-interface)',
    fix: 'Declare the harness under a non-empty id and set `agentic:` to true or false.',
  },
  'rejects with HarnessError reason timeout on timeout': {
    rule: 'timeout rejects with timeout (docs/harness-contract.md#failures)',
    fix: 'Make the CLI exit when its process group is killed; do not trap SIGTERM or detach child processes.',
  },
  'rejects with HarnessError reason empty_response on empty output': {
    rule: 'empty output rejects with empty_response (docs/harness-contract.md#failures)',
    fix: 'Set `output:` to where the CLI writes its answer so no output reads as empty.',
  },
  'rejects with a classified reason on nonzero failure': {
    rule: 'classified failure reason (docs/harness-contract.md#failures)',
    fix: 'Exit nonzero on failure, write the error to stderr, and map provider messages with `errorPatterns:`.',
  },
  'failure rejections carry a non-empty diagnostic message': {
    rule: 'non-empty failure message (docs/harness-contract.md#failures)',
    fix: 'Write a diagnostic to stderr whenever the CLI fails.',
  },
};

const INJECTION_RULE = {
  rule: 'injection fixtures (docs/harness-contract.md#testing-a-harness)',
  fix: 'Treat prompt content as data: return text or exit nonzero with a classified error, never hang or crash.',
};

export function ruleFor(name: string): { rule: string; fix: string } {
  if (name.startsWith(INJECTION_PREFIX)) return INJECTION_RULE;
  return HARNESS_CHECK_RULES[name] ?? FALLBACK;
}

function describeError(err: unknown): string {
  if (err instanceof HarnessError) return `${err.reason}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Runs every contract-kit case against the declared harness; never throws for a failing case. */
export async function runHarnessCheck(opts: HarnessCheckOptions): Promise<HarnessCheckResult[]> {
  const { id, declaration, model, registry } = opts;
  const execFn = opts.execFn ?? defaultExecFn;
  const dir = await mkdtemp(join(tmpdir(), 'factory-harness-check-'));
  try {
    await execFn('git init -q', { cwd: dir });
    const base = { model, registry, worktree: dir, prompt: PROBE_PROMPT, timeoutSeconds: 300 };
    const real = new CommandHarness(id, declaration, execFn);
    const scenarios: HarnessContractScenarios = {
      success: () => ({ harness: real, request: base }),
      timeout: () => ({ harness: real, request: { ...base, timeoutSeconds: 0.001 } }),
      emptyOutput: () => ({
        harness: new CommandHarness(id, { ...declaration, command: 'true' }, execFn),
        request: base,
      }),
      failure: () => ({
        harness: new CommandHarness(id, { ...declaration, command: FAILURE_COMMAND }, execFn),
        request: base,
      }),
    };
    const results: HarnessCheckResult[] = [];
    for (const c of codingHarnessContractCases(scenarios)) {
      const meta = ruleFor(c.name);
      try {
        await c.run();
        results.push({ name: c.name, ok: true, ...meta });
      } catch (err) {
        results.push({ name: c.name, ok: false, ...meta, error: describeError(err) });
      }
    }
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
