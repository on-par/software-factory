// packages/scbench-adapter/src/invoke.ts — factory run-brief argv + invocation (#510).
import type { ExecFn, ExecResult } from './workspace.js';

export interface BuildRunBriefArgsOptions {
  briefPath: string;
  workspace: string;
  artifactsDir: string;
}

/** Pure argv builder for `factory run-brief <brief> --workspace <ws> --artifacts <dir>`. */
export function buildRunBriefArgs(opts: BuildRunBriefArgsOptions): string[] {
  return ['run-brief', opts.briefPath, '--workspace', opts.workspace, '--artifacts', opts.artifactsDir];
}

export interface RunFactoryOptions {
  cwd: string;
  factoryBin?: string;
}

/** Runs `factory` with the given args in the SCBench workspace. Resolves the
 *  binary from opts.factoryBin, then FACTORY_BIN, then the bare "factory"
 *  name on PATH. A non-zero exit is NOT an adapter error — a failed/parked
 *  Factory run still emits a manifest for the caller to inspect. Environment
 *  passes through untouched; the adapter never forces a model policy. */
export async function runFactory(
  args: readonly string[],
  opts: RunFactoryOptions,
  deps: { exec: ExecFn },
): Promise<ExecResult> {
  const bin = opts.factoryBin ?? process.env.FACTORY_BIN ?? 'factory';
  return deps.exec([bin, ...args], { cwd: opts.cwd });
}
