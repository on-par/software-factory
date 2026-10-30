import { detectSandboxRuntime } from '@on-par/factory-core';

import type { DoctorEnvProbes } from './doctor.js';

/** The `codex installed` sandbox note. Unless sandbox.codexSandbox is workspace-write, Codex runs without its
 *  own sandbox (--sandbox danger-full-access, #3824) and the OS runtime, when present, is the only containment.
 *  Under workspace-write with no OS sandbox runtime on PATH this is the run-start Codex decision (#3082): the
 *  outer sandbox is off, Codex keeps its own workspace-write sandbox (#3233), and only tasks in
 *  sandbox.codexFullAccessTasks get danger-full-access (#3247). */
export function codexSandboxDetail(
  probes: Pick<DoctorEnvProbes, 'platform' | 'commandAvailable'>,
  fullAccessTasks: readonly string[],
  codexSandbox?: 'danger-full-access' | 'workspace-write',
): string {
  const hasRuntime = detectSandboxRuntime(probes.platform ?? process.platform, probes.commandAvailable) !== 'none';
  if (codexSandbox !== 'workspace-write') {
    return hasRuntime
      ? 'sandboxed builds available; codex runs without its own sandbox (--sandbox danger-full-access); set sandbox.codexSandbox: workspace-write to opt in'
      : "preflight: no OS sandbox runtime (sandbox-exec/firejail) on PATH; codex runs without its own sandbox (--sandbox danger-full-access) by default; to opt in to Codex's workspace-write sandbox, set sandbox.codexSandbox: workspace-write in .factory/config.yaml";
  }
  if (hasRuntime) return 'sandboxed builds available';
  const tasks = [...new Set(fullAccessTasks.filter((t) => t.trim() !== ''))];
  const grant = tasks.length > 0 ? `, and --sandbox danger-full-access for ${tasks.join(', ')}` : '';
  return (
    'preflight: no OS sandbox runtime (sandbox-exec/firejail) on PATH; codex will use --sandbox workspace-write' +
    `${grant}; to opt in to full access, list tasks under sandbox.codexFullAccessTasks in .factory/config.yaml`
  );
}

/** The note for the doctor probes: a throwing probe falls back to no tasks and the unset mode. */
export function codexSandboxNote(probes: DoctorEnvProbes): string {
  const attempt = <T>(read: (() => T) | undefined, fallback: T): T => {
    try {
      return read === undefined ? fallback : read();
    } catch {
      return fallback;
    }
  };
  return codexSandboxDetail(probes, attempt(probes.codexFullAccessTasks, []), attempt(probes.codexSandbox, undefined));
}
