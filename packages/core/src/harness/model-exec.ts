// src/harness/model-exec.ts — marks every exec an agent harness makes as a model execution, so the command output
// export never sends its output (ADR-0145 content privacy, ADR-0177). Applied once where harnesses get their exec.

import { withModelOutput } from '../command-output/tap.js';
import type { ExecFn } from '../utils/exec.js';

export function modelOutputExec(execFn: ExecFn): ExecFn {
  return (cmd, opts) => withModelOutput(() => execFn(cmd, opts));
}
