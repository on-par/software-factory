// packages/scbench-adapter/src/brief.ts — checkpoint → local Markdown brief (#510, #1163).
import type { ScbenchCheckpoint } from './checkpoint.js';
import type { ScbenchRetryContext } from './retry-context.js';

/** Turn a SCBench checkpoint into a Markdown brief that core's
 *  createLocalBriefAdapter (#507) resolves without error: an H1 title, the
 *  task verbatim, and a non-empty "## Acceptance criteria" section. */
export function materializeBrief(checkpoint: ScbenchCheckpoint): string {
  return `# SCBench ${checkpoint.problemId} — checkpoint ${checkpoint.checkpointId}

${checkpoint.task}

## Acceptance criteria

- Every example in the specification above reproduces exactly.
- Behaviour from earlier checkpoints is preserved.
- The workspace's test suite passes.
`;
}

function fenced(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

/** Rework variant of materializeBrief: the original checkpoint task verbatim
 *  plus the previous attempt's concrete failing assertions, so the retry is
 *  targeted at the evaluated failures rather than a blind re-run. Keeps the
 *  H1 + non-empty "## Acceptance criteria" contract core's
 *  createLocalBriefAdapter (#507) requires. */
export function materializeRetryBrief(checkpoint: ScbenchCheckpoint, ctx: ScbenchRetryContext): string {
  const failing =
    ctx.failedTests.length > 0
      ? ['Failing tests that must pass:', '', ...ctx.failedTests.map((t) => `- ${t.group}: ${t.name}`)].join('\n')
      : 'No per-test names were recorded; make all evaluation groups pass.';

  const sections = [
    `# SCBench ${ctx.problemId} — checkpoint ${ctx.checkpointId} (rework)`,
    checkpoint.task,
    '## Previous attempt failed SCBench evaluation',
    `Pass policy \`${ctx.passPolicy}\`; pytest exit code ${ctx.pytestExitCode}.`,
    failing,
  ];
  if (ctx.stderrExcerpt !== undefined) sections.push('### stderr excerpt', fenced(ctx.stderrExcerpt));
  if (ctx.stdoutExcerpt !== undefined) sections.push('### stdout excerpt', fenced(ctx.stdoutExcerpt));
  sections.push(
    '## Acceptance criteria',
    [
      '- Every example in the specification above reproduces exactly.',
      '- Behaviour from earlier checkpoints is preserved.',
      "- The workspace's test suite passes.",
      '- The failing tests listed above pass.',
    ].join('\n'),
  );

  return `${sections.join('\n\n')}\n`;
}
