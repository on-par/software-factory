// packages/scbench-adapter/src/checkpoint.ts — SCBench checkpoint + result types (#510).

/** One SCBench checkpoint task, as handed to the agent by the harness. */
export interface ScbenchCheckpoint {
  problemId: string;
  checkpointId: string;
  index: number;
  task: string;
}

/** Structured outcome of driving one checkpoint through Factory. A failed or
 *  parked Factory run still resolves here — SCBench proceeds to its own
 *  hidden evaluation; only adapter-level errors throw AdapterError. */
export interface CheckpointResult {
  outcome: 'ready' | 'failed' | 'parked' | 'escalated' | 'error';
  workspace: string;
  artifactsDir: string;
  briefPath: string;
  manifestPath?: string;
  detail?: string;
}

/** Raised for adapter-level failures (bad args, unwritable dirs) — never for
 *  a Factory run outcome, which is captured in CheckpointResult instead. */
export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}
