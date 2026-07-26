// packages/product/src/cli/prompter.test.ts (#470).

import { createInterface } from 'node:readline/promises';

import { describe, expect, it, vi } from 'vitest';

import { createStdinPrompter } from './prompter.js';

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(async () => 'answer'),
    close: vi.fn(),
  })),
}));

describe('createStdinPrompter', () => {
  it('forwards the question with a prompt marker and returns the answer', async () => {
    const prompter = createStdinPrompter();
    await expect(prompter.ask('Q?')).resolves.toBe('answer');

    const rl = vi.mocked(createInterface).mock.results[0]?.value;
    expect(rl.question).toHaveBeenCalledWith('Q?\n> ');
  });

  it('closes the underlying readline interface', () => {
    const prompter = createStdinPrompter();
    prompter.close();

    const rl = vi.mocked(createInterface).mock.results.at(-1)?.value;
    expect(rl.close).toHaveBeenCalled();
  });
});
