// packages/product/src/cli/prompter.test.ts (#470, #2023).

import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createStdinPrompter } from './prompter.js';
import type { PrompterInterface, StdinPrompterDeps } from './prompter.js';

type InterfaceOptions = Parameters<StdinPrompterDeps['createInterface']>[0];

function recordingInterface(answer = 'answer') {
  const rl = {
    questions: [] as string[],
    closed: 0,
    question: async (query: string) => {
      rl.questions.push(query);
      return answer;
    },
    close: () => {
      rl.closed += 1;
    },
  };
  return rl;
}

function recordingFactory() {
  const rl = recordingInterface();
  const calls: InterfaceOptions[] = [];
  const createInterface = (options: InterfaceOptions): PrompterInterface => {
    calls.push(options);
    return rl;
  };
  return { rl, calls, createInterface };
}

describe('createStdinPrompter', () => {
  it('forwards the question with a prompt marker and returns the answer', async () => {
    const { rl, createInterface } = recordingFactory();
    const prompter = createStdinPrompter({ createInterface, input: new PassThrough(), output: new PassThrough() });

    await expect(prompter.ask('Q?')).resolves.toBe('answer');
    expect(rl.questions).toEqual(['Q?\n> ']);
  });

  it('closes the underlying readline interface', () => {
    const { rl, createInterface } = recordingFactory();
    const prompter = createStdinPrompter({ createInterface, input: new PassThrough(), output: new PassThrough() });

    prompter.close();
    expect(rl.closed).toBe(1);
  });

  it('defaults input and output to process stdin and stdout', () => {
    const { calls, createInterface } = recordingFactory();
    createStdinPrompter({ createInterface });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(process.stdin);
    expect(calls[0]?.output).toBe(process.stdout);
  });

  it('defaults createInterface to the real readline', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => {
      written += String(chunk);
    });

    const prompter = createStdinPrompter({ input, output });
    const answer = prompter.ask('Q?');
    input.write('hi\n');

    await expect(answer).resolves.toBe('hi');
    expect(written).toContain('Q?\n> ');
    prompter.close();
  });
});
