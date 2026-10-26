import { detectSandboxRuntime } from '@on-par/factory-core';

import type { DoctorEnvProbes } from './doctor.js';

/** The `codex installed` sandbox note. With no OS sandbox runtime on PATH this is the run-start Codex
 *  decision (#3082): the outer sandbox is off, Codex keeps its own workspace-write sandbox (#3233), and only
 *  tasks in sandbox.codexFullAccessTasks get danger-full-access (#3247). */
export function codexSandboxDetail(
  probes: Pick<DoctorEnvProbes, 'platform' | 'commandAvailable'>,
  fullAccessTasks: readonly string[],
): string {
  if (detectSandboxRuntime(probes.platform ?? process.platform, probes.commandAvailable) !== 'none')
    return 'sandboxed builds available';
  const tasks = [...new Set(fullAccessTasks.filter((t) => t.trim() !== ''))];
  const grant = tasks.length > 0 ? `, and --sandbox danger-full-access for ${tasks.join(', ')}` : '';
  return (
    'preflight: no OS sandbox runtime (sandbox-exec/firejail) on PATH; codex will use --sandbox workspace-write' +
    `${grant}; to opt in to full access, list tasks under sandbox.codexFullAccessTasks in .factory/config.yaml`
  );
}
