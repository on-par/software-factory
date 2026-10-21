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
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError, type HarnessRequest } from './index.js';

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
  /** When set, the case was not run; `ok` is true so it does not fail the check. */
  skip?: string;
}

const PROBE_PROMPT = 'Reply with the single word ok. Do not edit any files.';
const FAILURE_COMMAND = `sh -c 'echo "rate limit" >&2; exit 1'`;
const INJECTION_PREFIX = 'handles injected instruction without following it:';

const COMMIT_CASE = 'commits a change in the worktree';
const COMMIT_FILE = 'HARNESS_CHECK.txt';
const COMMIT_PROMPT =
  'Create a file named HARNESS_CHECK.txt in the current directory containing the single line ok, then commit it with git (git add HARNESS_CHECK.txt && git commit -m "harness check"). Commit locally only; do not push.';

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
  [COMMIT_CASE]: {
    rule: 'commits locally in the worktree (docs/harness-contract.md#build)',
    fix: 'BUILD needs the agent to edit files and commit them locally in the worktree (git add + git commit) and not push. Make the CLI run with write access in its cwd and allow git commit.',
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

/** A fast CLI (e.g. `echo ok`) can exit before a 1ms timer fires — routinely on Linux or a busy event
 *  loop — and the run then resolves instead of timing out. Keeping the process group alive after the CLI,
 *  and killing the whole group via onPgid, makes the timeout case deterministic. A newline, not `;`,
 *  so a trailing `#` comment in the declared command cannot swallow the sleep. */
function lingeringExec(execFn: ExecFn): ExecFn {
  return (cmd, o) => execFn(`${cmd}\nsleep 30`, o);
}

/** Runs the CLI in a fresh scratch repo and checks it left a new commit tracking HARNESS_CHECK.txt.
 *  Returns undefined on pass, an error string on failure. */
async function checkCommitsInWorktree(
  harness: CommandHarness,
  request: Omit<Partial<HarnessRequest>, 'worktree' | 'prompt'>,
  execFn: ExecFn,
): Promise<string | undefined> {
  const repo = await mkdtemp(join(tmpdir(), 'factory-harness-commit-'));
  try {
    await execFn('git init -q', { cwd: repo });
    // A local identity lets the agent commit on hosts with no global git identity (e.g. CI).
    await execFn('git config user.name "factory harness check"', { cwd: repo });
    await execFn('git config user.email "harness-check@factory.invalid"', { cwd: repo });
    await execFn('git commit -q --allow-empty -m seed', { cwd: repo });
    const seed = (await execFn('git rev-parse HEAD', { cwd: repo })).stdout.trim();
    try {
      await harness.run(makeContractRequest({ ...request, worktree: repo, prompt: COMMIT_PROMPT }));
    } catch (err) {
      return describeError(err);
    }
    const count = Number((await execFn(`git rev-list --count ${seed}..HEAD`, { cwd: repo })).stdout.trim());
    if (!(count >= 1)) return 'no new commit was found: HEAD did not advance past the seed commit';
    try {
      await execFn(`git ls-files --error-unmatch ${COMMIT_FILE}`, { cwd: repo });
    } catch {
      return `${COMMIT_FILE} is not tracked at HEAD`;
    }
    return undefined;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
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
      timeout: () => ({
        harness: new CommandHarness(id, declaration, lingeringExec(execFn)),
        request: { ...base, timeoutSeconds: 0.001, onPgid: () => {} },
      }),
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
    const commitMeta = ruleFor(COMMIT_CASE);
    if (!declaration.agentic) {
      results.push({ name: COMMIT_CASE, ok: true, ...commitMeta, skip: 'agentic: false' });
    } else {
      try {
        const error = await checkCommitsInWorktree(real, base, execFn);
        results.push(
          error === undefined
            ? { name: COMMIT_CASE, ok: true, ...commitMeta }
            : { name: COMMIT_CASE, ok: false, ...commitMeta, error },
        );
      } catch (err) {
        results.push({ name: COMMIT_CASE, ok: false, ...commitMeta, error: describeError(err) });
      }
    }
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
