// packages/scbench-adapter/src/brief.ts — checkpoint → local Markdown brief (#510).
import type { ScbenchCheckpoint } from './checkpoint.js';

/** Turn a SCBench checkpoint into a Markdown brief that core's
 *  createLocalBriefAdapter (#507) resolves without error: an H1 title, the
 *  task verbatim, and a non-empty "## Acceptance criteria" section. */
export function materializeBrief(checkpoint: ScbenchCheckpoint): string {
  return `# SCBench ${checkpoint.problemId} — checkpoint ${checkpoint.checkpointId}

${checkpoint.task}

## Acceptance criteria

- The workspace implements the checkpoint specification above; SlopCodeBench's hidden evaluation for checkpoint ${checkpoint.checkpointId} passes against the resulting code.
`;
}
