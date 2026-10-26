// packages/cli/src/cli/draft-command.ts — `factory draft` command body: idea input, exit-code mapping (#3171)
import { readFileSync } from 'node:fs';
import { draftErrorExit, draftResultExit, resolveDraftIdea, runIssueDraft } from './draft.js';
import { CliExitError } from './errors.js';
import type { DeepCheckModelRunner } from './ready-check.js';

/** Reads the idea, runs the draft and maps the result to a CLI exit. Never touches GitHub, the queue or files it writes. */
export async function runDraftCommand(
  opts: { text?: string; file?: string; json?: boolean },
  makeRunModel: () => Promise<DeepCheckModelRunner>,
): Promise<void> {
  try {
    const idea = await resolveDraftIdea(opts, {
      readFile: async (p) => readFileSync(p, 'utf-8'),
      readStdin: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString('utf-8');
      },
      stdinIsTTY: process.stdin.isTTY,
    });
    const result = await runIssueDraft(idea, opts, {
      runModel: await makeRunModel(),
      log: (l) => console.log(l),
      info: (l) => console.error(l),
    });
    const exit = draftResultExit(result);
    if (exit) throw new CliExitError(exit.message, exit.code);
  } catch (err) {
    const exit = draftErrorExit(err);
    if (exit) throw new CliExitError(exit.message, exit.code);
    throw err;
  }
}
