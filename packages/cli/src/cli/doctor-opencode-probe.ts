// packages/cli/src/cli/doctor-opencode-probe.ts — live OpenCode auth probe for `factory doctor --probe-inference` (#2892)

import { applyRepoConfig } from '@on-par/factory-core';
import {
  classifyFailure,
  classifyOpenCodeErrorType,
  parseOpenCodeJson,
  shellEscape,
} from '@on-par/factory-core/internal';

import type { DoctorCheck, DoctorRuntime } from './doctor.js';

export const OPENCODE_LIVE_AUTH_CHECK = 'opencode auth (live)';
export const OPENCODE_PROBE_TIMEOUT_MS = 60_000;

/** One `opencode run` probe (#2892): not run, timed out, or ran with its captured output. */
export type OpencodeAuthProbeResult =
  { kind: 'skipped' } | { kind: 'timeout' } | { kind: 'ran'; exitCode: number; stdout: string; stderr: string };

export function opencodeAuthProbeCommand(providerModel?: string): string {
  const model = providerModel ? ` --model ${shellEscape(providerModel)}` : '';
  return `opencode run --format json${model} "reply with exactly: ok"`;
}

/** Provider model of the repo's first OpenCode-harness pin (build, plan, checker, triage), if any. */
export function pinnedOpencodeProviderModel(
  models: ReturnType<DoctorRuntime['configLoaders']['loadModelsConfig']>,
  repo: ReturnType<DoctorRuntime['configLoaders']['loadRepoConfig']>,
): string | undefined {
  try {
    const merged = applyRepoConfig(models, repo).models;
    for (const field of ['build', 'plan', 'checker', 'triage'] as const) {
      const id = repo?.models?.pins?.[field];
      const def = id ? merged[id] : undefined;
      if (def?.harness === 'opencode' && typeof def.providerModel === 'string' && def.providerModel !== '') {
        return def.providerModel;
      }
    }
  } catch {
    // config problems are reported by the config checks
  }
  return undefined;
}

/** Maps one `opencode run` probe to the `opencode auth (live)` row (#2892). */
export function opencodeLiveAuthCheck(result: OpencodeAuthProbeResult): DoctorCheck {
  const name = OPENCODE_LIVE_AUTH_CHECK;
  if (result.kind === 'skipped') {
    return { name, ok: true, optional: true, detail: 'skipped: opencode CLI not on PATH' };
  }
  if (result.kind === 'timeout') {
    return {
      name,
      ok: false,
      detail: 'opencode run timed out after 60s',
      fix: 'check your network and provider status, then re-run `factory doctor --probe-inference`',
    };
  }
  const { exitCode, stdout, stderr } = result;
  const parsed = parseOpenCodeJson(stdout);
  if (parsed && parsed.text.trim() !== '' && parsed.errorText === '') {
    return { name, ok: true, detail: 'opencode run succeeded' };
  }
  const errorText = parsed?.errorText ?? '';
  const fallbackText = [stderr, errorText].filter(Boolean).join('\n');
  const reason =
    classifyOpenCodeErrorType(parsed?.errorType) ??
    (parsed?.errorStatus === 401 || parsed?.errorStatus === 403 || /\bstatus (401|403)\b/.test(errorText)
      ? 'local_auth'
      : undefined) ??
    (fallbackText !== '' ? classifyFailure(fallbackText, exitCode || 1) : undefined);
  const firstError =
    errorText.split('\n')[0] || stderr.split('\n')[0] || `no text in opencode run output (exit ${exitCode})`;
  if (reason === 'local_auth') {
    return {
      name,
      ok: false,
      detail: `opencode rejected the stored credential: ${firstError}`,
      fix: 'opencode auth login',
      next: 'opencode auth login',
    };
  }
  if (reason === 'usage_cap' || reason === 'rate_limit') {
    return {
      name,
      ok: false,
      optional: true,
      detail: `opencode hit a ${reason === 'usage_cap' ? 'usage cap' : 'rate limit'} (the credential was accepted): ${firstError}`,
    };
  }
  return {
    name,
    ok: false,
    detail: `opencode run failed: ${firstError}`,
    fix: 'run `opencode run "hi"` to see the error, or `opencode auth login`',
  };
}

/** Runs the one `opencode run` probe; a thrown exec error keeps its stdout, status and timeout flag. */
export function runOpencodeAuthProbe(rt: DoctorRuntime, repoRoot: string | null): OpencodeAuthProbeResult {
  if (!rt.coreOps.isCommandAvailable('opencode')) return { kind: 'skipped' };
  let providerModel: string | undefined;
  if (repoRoot !== null) {
    try {
      providerModel = pinnedOpencodeProviderModel(
        rt.configLoaders.loadModelsConfig(),
        rt.configLoaders.loadRepoConfig(repoRoot),
      );
    } catch {
      // config problems are reported elsewhere
    }
  }
  try {
    const stdout = rt.shellOps.execSync(opencodeAuthProbeCommand(providerModel), {
      timeout: OPENCODE_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { kind: 'ran', exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { code?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown };
    if (e.code === 'ETIMEDOUT') return { kind: 'timeout' };
    return {
      kind: 'ran',
      exitCode: typeof e.status === 'number' ? e.status : 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
}
