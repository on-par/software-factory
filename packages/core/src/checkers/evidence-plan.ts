import type { EvidenceKind, EvidencePlanEntry } from '@on-par/contracts';
import { shellEscape } from '../utils/index.js';
import type { RunCommandOptions } from '../utils/command-runner.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { wrapCommandInSandbox } from '../sandbox/index.js';
import type { EvidenceAllowlist } from './evidence-allowlist.js';
import { tokenizeEvidenceCommand } from './evidence-allowlist.js';
import { runVerificationCommand } from './run-command.js';
import type { CheckerContext } from './index.js';
import type { EvidenceTestRunner } from './evidence-selector.js';
import { SELECTOR_UNUSABLE_PREFIX, parseFailToPassSelector, selectorArgs } from './evidence-selector.js';
import { verifyFailToPass } from './evidence-plan-false-pass.js';

export interface EvidencePlanResult {
  claim: string;
  kind: EvidenceKind;
  status: 'PASS' | 'FAIL' | 'SKIP';
  reason: string;
  outputTail?: string;
  passWhenNotMachineChecked?: boolean;
  headRun?: EvidenceTestRun;
  baseRun?: EvidenceTestRun;
  baseSha?: string;
  /** set by verifyFailToPass when base and head failed identically (#3749); triage classes it infra */
  sharedFailure?: string;
}

export interface EvidenceTestRun {
  exitCode: number;
  timedOut: boolean;
  killed: boolean;
  outputTail?: string;
}

export interface EvidenceCommandLifecycle {
  beforeCommand(): Promise<void>;
  afterCommand(command: string, pgids: readonly number[]): Promise<void>;
}

export type EvidenceRunnerContext = Pick<
  CheckerContext,
  'worktree' | 'sandbox' | 'env' | 'onPgid' | 'runCommand' | 'testsTimeoutSeconds' | 'diffBase' | 'parentBaseRef'
> & { testRunner?: EvidenceTestRunner | null };

const OUTPUT_LIMIT = 2000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MANAGER = /^(npm|pnpm|yarn|bun)$/;

function tail(stdout: string, stderr: string): string | undefined {
  const output = `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.slice(-OUTPUT_LIMIT);
  return output || undefined;
}

function result(
  entry: EvidencePlanEntry,
  status: EvidencePlanResult['status'],
  reason: string,
  outputTail?: string,
): EvidencePlanResult {
  const proseOnly = entry.kind === 'command' && !entry.expect && status !== 'SKIP';
  const finalReason = proseOnly ? `${reason}; passWhen not machine-checked` : reason;
  return {
    claim: entry.claim,
    kind: entry.kind,
    status,
    reason: finalReason,
    ...(outputTail ? { outputTail } : {}),
    ...(proseOnly ? { passWhenNotMachineChecked: true } : {}),
  };
}

function boundedReason(reason: string): string {
  if (reason.length <= OUTPUT_LIMIT) return reason;
  const marker = '\n… diagnostic truncated';
  return `${reason.slice(0, OUTPUT_LIMIT - marker.length)}${marker}`;
}

function expectedParts(parts: readonly string[]): string {
  const rendered = JSON.stringify(parts);
  return rendered.length <= 500 ? rendered : `${rendered.slice(0, 480)}…[truncated]`;
}

function actualOutput(output: string): string {
  if (!output) return '<empty>';
  return output.length <= 600 ? output : `…[truncated]${output.slice(-600)}`;
}

/** SKIP reason for evidence text the shell-free tokenizer rejects, distinct from a command missing from the allowlist (#3600). */
const UNSUPPORTED_SHELL_SYNTAX =
  'unsupported shell syntax (evidence runs one shell-free command: no pipes, redirects, ;, &, $, backticks, globs or VAR= prefixes)';

function resolveArgv(text: string, allowlist: EvidenceAllowlist): string[] | null {
  const parts = tokenizeEvidenceCommand(text);
  if (!parts) return null;
  let name = parts[0]!;
  let args = parts.slice(1);
  if (MANAGER.test(name) && parts[1] === 'run' && parts[2]) {
    name = parts[2];
    args = parts.slice(3);
  }
  const canonical = allowlist.get(name);
  if (!canonical || canonical.length === 0 || canonical.some((part) => typeof part !== 'string' || !part)) return null;
  const argv = [...canonical];
  if (args.length > 0) {
    const npmScript = canonical[0] === 'npm' && canonical[1] === 'run';
    if (npmScript && args[0] !== '--') argv.push('--');
    argv.push(...args);
  }
  return argv;
}

function evidencePolicy(policy: SandboxPolicy | undefined): SandboxPolicy | null {
  if (!policy || (policy.runtime !== 'sandbox-exec' && policy.runtime !== 'firejail')) return null;
  const { proxyUrl: _proxyUrl, ...rest } = policy;
  return {
    ...rest,
    writablePaths: [...policy.writablePaths],
    writableFilePrefixes: [...policy.writableFilePrefixes],
    allowHosts: [],
    allowLoopback: true,
  };
}

async function execute(
  entry: EvidencePlanEntry,
  argv: string[],
  policy: SandboxPolicy,
  ctx: EvidenceRunnerContext,
  lifecycle?: EvidenceCommandLifecycle,
): Promise<EvidencePlanResult> {
  const timeoutSeconds = ctx.testsTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const command = wrapCommandInSandbox(argv.map(shellEscape).join(' '), policy);
  const env: Record<string, string | undefined> = { ...ctx.env, FACTORY_RUN_CONFIG_JSON: undefined };
  const pgids: number[] = [];
  const options: RunCommandOptions = {
    cwd: ctx.worktree,
    env,
    timeoutMs: timeoutSeconds * 1000,
    onPgid: (pgid) => {
      pgids.push(pgid);
      ctx.onPgid?.(pgid);
    },
  };
  let started = false;
  try {
    await lifecycle?.beforeCommand();
    started = true;
    const run = ctx.runCommand ?? runVerificationCommand;
    const outcome = await run(['/bin/sh', '-c', command], options);
    const outputTail = tail(outcome.stdout, outcome.stderr);
    const completed = (value: EvidencePlanResult): EvidencePlanResult =>
      entry.kind === 'fail-to-pass-test'
        ? {
            ...value,
            headRun: {
              exitCode: outcome.exitCode,
              timedOut: outcome.timedOut,
              killed: outcome.killed,
              ...(outputTail ? { outputTail } : {}),
            },
          }
        : value;
    if (outcome.timedOut) return completed(result(entry, 'FAIL', `timed out after ${timeoutSeconds}s`, outputTail));
    if (outcome.killed) return completed(result(entry, 'FAIL', 'terminated', outputTail));
    if (entry.kind === 'command' && entry.expect) {
      const expectedExit = entry.expect.exitCode ?? 0;
      const required = entry.expect.stdoutContains ?? [];
      const missing = required.filter((part) => !outcome.stdout.includes(part));
      if (outcome.exitCode === expectedExit && missing.length === 0) {
        return completed(
          result(
            entry,
            'PASS',
            `expected exit ${expectedExit}; matched stdout requirements ${expectedParts(required)}`,
            outputTail,
          ),
        );
      }
      const summary = `claim ${entry.claim}: expected exit ${expectedExit}, actual exit ${outcome.exitCode}; expected stdout substrings ${expectedParts(required)}; missing stdout substrings ${expectedParts(missing)}; actual stdout: ${actualOutput(outcome.stdout)}; actual stderr: ${actualOutput(outcome.stderr)}`;
      return completed(result(entry, 'FAIL', boundedReason(summary), outputTail));
    }
    if (outcome.exitCode === 0) return completed(result(entry, 'PASS', 'exited with code 0', outputTail));
    return completed(result(entry, 'FAIL', `exited with code ${outcome.exitCode}`, outputTail));
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(-OUTPUT_LIMIT);
    return result(entry, 'FAIL', `execution error: ${message}`);
  } finally {
    if (started) {
      const label =
        entry.kind === 'command' ? entry.command : entry.kind === 'fail-to-pass-test' ? entry.test : entry.kind;
      await lifecycle?.afterCommand(label, pgids);
    }
  }
}

export async function runEvidencePlan(
  entries: readonly EvidencePlanEntry[] | null | undefined,
  allowlist: EvidenceAllowlist,
  ctx: EvidenceRunnerContext,
  lifecycle?: EvidenceCommandLifecycle,
): Promise<EvidencePlanResult[]> {
  if (!entries?.length) return [];
  const results: EvidencePlanResult[] = [];
  for (const entry of entries) {
    if (entry.kind === 'screenshot') {
      results.push(result(entry, 'SKIP', entry.route));
      continue;
    }
    if (entry.kind === 'none') {
      results.push(result(entry, 'SKIP', entry.reason));
      continue;
    }
    if (entry.kind === 'command' && !tokenizeEvidenceCommand(entry.command)) {
      results.push(result(entry, 'SKIP', UNSUPPORTED_SHELL_SYNTAX));
      continue;
    }
    const argv = entry.kind === 'command' ? resolveArgv(entry.command, allowlist) : resolveArgv('test', allowlist);
    if (!argv) {
      results.push(result(entry, 'SKIP', 'not allowlisted'));
      continue;
    }
    if (entry.kind === 'fail-to-pass-test') {
      if (!tokenizeEvidenceCommand(entry.test)) {
        results.push(result(entry, 'SKIP', UNSUPPORTED_SHELL_SYNTAX));
        continue;
      }
      const selector = parseFailToPassSelector(entry.test);
      if (!selector) {
        results.push(
          result(
            entry,
            'SKIP',
            `${SELECTOR_UNUSABLE_PREFIX}: expected a test file path optionally followed by quoted test names (e.g. src/a.test.ts "does x"); the whole suite is never run instead`,
          ),
        );
        continue;
      }
      const runner = ctx.testRunner;
      if (!runner) {
        results.push(
          result(
            entry,
            'SKIP',
            `${SELECTOR_UNUSABLE_PREFIX}: test runner not recognised (supported: vitest, jest, pytest); the whole suite is never run instead`,
          ),
        );
        continue;
      }
      if (argv[0] === 'npm' && argv[1] === 'run') argv.push('--');
      argv.push(...selectorArgs(selector, runner));
    }
    const policy = evidencePolicy(ctx.sandbox);
    if (!policy) {
      results.push(result(entry, 'SKIP', 'sandbox unavailable'));
      continue;
    }
    const head = await execute(entry, argv, policy, ctx, lifecycle);
    if (entry.kind !== 'fail-to-pass-test') {
      results.push(head);
      continue;
    }
    results.push(
      await verifyFailToPass(entry, head, ctx, async (worktree) => {
        const basePolicy: SandboxPolicy = {
          ...policy,
          worktree,
          writablePaths: [...policy.writablePaths, worktree],
          writableFilePrefixes: [...policy.writableFilePrefixes],
        };
        return execute(entry, argv, basePolicy, { ...ctx, worktree, sandbox: basePolicy }, lifecycle);
      }),
    );
  }
  return results;
}
