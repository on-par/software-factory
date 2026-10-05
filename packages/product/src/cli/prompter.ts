// packages/product/src/cli/prompter.ts — stdin Q&A for `product interview` (#470).
import { createInterface } from 'node:readline/promises';

export interface Prompter {
  ask(question: string): Promise<string>;
  close(): void;
}

/** The slice of a readline/promises Interface the prompter uses. */
export interface PrompterInterface {
  question(query: string): Promise<string>;
  close(): void;
}

/** Injectable seam so tests can supply a recording fake instead of mocking readline (#2023). */
export interface StdinPrompterDeps {
  createInterface: (options: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) => PrompterInterface;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** One readline interface for the whole interview — reopening stdin per question is fragile. */
export function createStdinPrompter(deps: Partial<StdinPrompterDeps> = {}): Prompter {
  const { createInterface: open = createInterface, input = process.stdin, output = process.stdout } = deps;
  const rl = open({ input, output });
  return {
    ask: (question) => rl.question(`${question}\n> `),
    close: () => rl.close(),
  };
}
