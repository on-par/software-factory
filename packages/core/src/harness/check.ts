// src/harness/check.ts — runs the harness contract kit against a declared harness (#2875).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HarnessDeclaration } from '../config/index.js';
import type { ModelRegistry } from '../models/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { CommandHarness } from './command.js';
import type { HarnessContractScenario } from './contract.js';
import { codingHarnessContractCases } from './contract.js';
import { HarnessError } from './index.js';

export interface HarnessCheckResult {
  name: string;
  ok: boolean;
  /** The contract rule the case enforces, with a docs anchor. */
  rule: string;
  /** A concrete change that makes the case pass. */
  fix: string;
  error?: string;
}

export interface HarnessCheckOptions {
  id: string;
  declaration: HarnessDeclaration;
  /** Registry model id (a key in the registry's models). */
  model: string;
  registry: ModelRegistry;
  execFn?: ExecFn;
  /** Default true; false drops the injection cases (they call the real CLI). */
  injection?: boolean;
  /** Budget for success and injection runs, default 120. */
  timeoutSeconds?: number;
}

const DOCS = 'docs/harness-contract.md';
const INJECTION_PREFIX = 'handles injected instruction';

/** The trailing word becomes `$0`, so the prompt argument or `< file` CommandHarness appends is harmless. */
const FAILURE_COMMAND = 'sh -c \'echo "rate limit" >&2; exit 1\' harness-check';

/** Maps a kit case name to the contract rule it enforces and a fix for the harness author. */
export function harnessCheckRule(caseName: string, id: string): { rule: string; fix: string } {
  if (caseName.startsWith(INJECTION_PREFIX)) {
    return {
      rule: `injection fixtures (${DOCS}#inputs-harnessrequest)`,
      fix: 'the command must return text or exit nonzero for any prompt; pass the prompt as data (prompt: stdin, file or arg), never evaluate it',
    };
  }
  switch (caseName) {
    case 'resolves with non-empty output on success':
      return {
        rule: `non-empty output (${DOCS}#outputs-harnessresult)`,
        fix: `make the command print its answer, and set output: under harnesses.${id} to where it goes (stdout, jsonl, or file:{outFile})`,
      };
    case 'exposes a stable id and agentic capability':
      return {
        rule: `interface (${DOCS}#the-interface)`,
        fix: `set agentic: true or false under harnesses.${id}`,
      };
    case 'rejects with HarnessError reason timeout on timeout':
      return {
        rule: `timeout (${DOCS}#inputs-harnessrequest)`,
        fix: 'the command must run in the foreground and exit when killed; do not detach or background the agent',
      };
    case 'rejects with HarnessError reason empty_response on empty output':
      return {
        rule: `empty output rejects (${DOCS}#outputs-harnessresult)`,
        fix: `set output: under harnesses.${id} to match where the CLI writes its answer`,
      };
    case 'rejects with a classified reason on nonzero failure':
    case 'failure rejections carry a non-empty diagnostic message':
      return {
        rule: `classified failures (${DOCS}#failures)`,
        fix: `exit nonzero on failure and write the error to stderr; add errorPatterns: under harnesses.${id} to map it to a reason`,
      };
    default:
      return { rule: `contract (${DOCS})`, fix: `see ${DOCS}` };
  }
}

function describeError(err: unknown): string {
  const text =
    err instanceof HarnessError ? `${err.reason}: ${err.message}` : err instanceof Error ? err.message : String(err);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** Runs every contract case against the declared harness; a failing case is a result, never a throw. */
export async function runHarnessCheck(opts: HarnessCheckOptions): Promise<HarnessCheckResult[]> {
  const execFn = opts.execFn ?? defaultExecFn;
  const dir = await mkdtemp(join(tmpdir(), 'factory-harness-check-'));
  try {
    await execFn('git init -q', { cwd: dir, timeoutMs: 30_000 });

    const base = {
      model: opts.model,
      registry: opts.registry,
      worktree: dir,
      prompt: 'Reply with the single word ok.',
      task: 'plan' as const,
      timeoutSeconds: opts.timeoutSeconds ?? 120,
    };
    const scenario = (
      declaration: HarnessDeclaration,
      request: Partial<typeof base> = {},
    ): HarnessContractScenario => ({
      harness: new CommandHarness(opts.id, declaration, execFn),
      request: { ...base, ...request },
    });

    let cases = codingHarnessContractCases({
      success: () => scenario(opts.declaration),
      timeout: () => scenario(opts.declaration, { timeoutSeconds: 0.001 }),
      emptyOutput: () => scenario({ ...opts.declaration, command: 'true' }),
      failure: () => scenario({ ...opts.declaration, command: FAILURE_COMMAND }),
    });
    if (opts.injection === false) cases = cases.filter((c) => !c.name.startsWith(INJECTION_PREFIX));

    const results: HarnessCheckResult[] = [];
    for (const c of cases) {
      let error: string | undefined;
      try {
        await c.run();
      } catch (err) {
        error = describeError(err);
      }
      results.push({
        name: c.name,
        ok: error === undefined,
        ...harnessCheckRule(c.name, opts.id),
        ...(error === undefined ? {} : { error }),
      });
    }
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
