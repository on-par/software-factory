// packages/product/src/cli/prompter.ts — stdin Q&A for `product interview` (#470).
import { createInterface } from 'node:readline/promises';

export interface Prompter {
  ask(question: string): Promise<string>;
  close(): void;
}

/** One readline interface for the whole interview — reopening stdin per question is fragile. */
export function createStdinPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (question) => rl.question(`${question}\n> `),
    close: () => rl.close(),
  };
}
