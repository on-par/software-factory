import type { EvidenceKind, EvidencePlanEntry } from '@on-par/contracts';
import { shellEscape } from '../utils/index.js';
import type { RunCommandOptions } from '../utils/command-runner.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { wrapCommandInSandbox } from '../sandbox/index.js';
import type { EvidenceAllowlist } from './evidence-allowlist.js';
import { tokenizeEvidenceCommand } from './evidence-allowlist.js';
import { runVerificationCommand } from './run-command.js';
import type { CheckerContext } from './index.js';

export interface EvidencePlanResult {
  claim: string;
  kind: EvidenceKind;
  status: 'PASS' | 'FAIL' | 'SKIP';
  reason: string;
  outputTail?: string;
}

export type EvidenceRunnerContext = Pick<
  CheckerContext,
  'worktree' | 'sandbox' | 'env' | 'onPgid' | 'runCommand' | 'testsTimeoutSeconds'
>;

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
  return { claim: entry.claim, kind: entry.kind, status, reason, ...(outputTail ? { outputTail } : {}) };
}

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
  };
}

async function execute(
  entry: EvidencePlanEntry,
  argv: string[],
  policy: SandboxPolicy,
  ctx: EvidenceRunnerContext,
): Promise<EvidencePlanResult> {
  const timeoutSeconds = ctx.testsTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const command = wrapCommandInSandbox(argv.map(shellEscape).join(' '), policy);
  const env: Record<string, string | undefined> = { ...ctx.env, FACTORY_RUN_CONFIG_JSON: undefined };
  const options: RunCommandOptions = {
    cwd: ctx.worktree,
    env,
    timeoutMs: timeoutSeconds * 1000,
    onPgid: (pgid) => ctx.onPgid?.(pgid),
  };
  try {
    const run = ctx.runCommand ?? runVerificationCommand;
    const outcome = await run(['/bin/sh', '-c', command], options);
    const outputTail = tail(outcome.stdout, outcome.stderr);
    if (outcome.timedOut) return result(entry, 'FAIL', `timed out after ${timeoutSeconds}s`, outputTail);
    if (outcome.killed) return result(entry, 'FAIL', 'terminated', outputTail);
    if (outcome.exitCode === 0) return result(entry, 'PASS', 'exited with code 0', outputTail);
    return result(entry, 'FAIL', `exited with code ${outcome.exitCode}`, outputTail);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(-OUTPUT_LIMIT);
    return result(entry, 'FAIL', `execution error: ${message}`);
  }
}

export async function runEvidencePlan(
  entries: readonly EvidencePlanEntry[] | null | undefined,
  allowlist: EvidenceAllowlist,
  ctx: EvidenceRunnerContext,
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
    const argv = entry.kind === 'command' ? resolveArgv(entry.command, allowlist) : resolveArgv('test', allowlist);
    if (!argv) {
      results.push(result(entry, 'SKIP', 'not allowlisted'));
      continue;
    }
    if (entry.kind === 'fail-to-pass-test') {
      const selector = tokenizeEvidenceCommand(entry.test);
      if (!selector) {
        results.push(result(entry, 'SKIP', 'not allowlisted'));
        continue;
      }
      const npmScript = argv[0] === 'npm' && argv[1] === 'run';
      if (npmScript && selector[0] !== '--') argv.push('--');
      argv.push(...selector);
    }
    const policy = evidencePolicy(ctx.sandbox);
    if (!policy) {
      results.push(result(entry, 'SKIP', 'sandbox unavailable'));
      continue;
    }
    results.push(await execute(entry, argv, policy, ctx));
  }
  return results;
}
