// packages/cli/src/cli/draft-command.test.ts — `factory draft` command body (#3171)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirs } from '@on-par/factory-core/testing';
import { runDraftCommand } from './draft-command.js';
import { CliExitError } from './errors.js';

const tempDirs = createTempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

const BODY = (verification: string) =>
  `# Do the thing

## User story

As an operator, I want the thing, so that work moves.

## Problem statement

The thing cannot be done today.

## In scope

- Do the thing.

## Out of scope

- Other things.

## Acceptance criteria

- [ ] Given a start, When the thing runs, Then it is done.

## Regression test

A test does the thing.
${verification}`;

describe('runDraftCommand', () => {
  it('reads the idea from piped stdin', async () => {
    const stdin = Object.assign(
      (async function* () {
        yield Buffer.from('idea from ');
        yield Buffer.from('stdin');
      })(),
      { isTTY: false },
    );
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const prompts: string[] = [];
    const runModel = async (_task: string, prompt: string) => {
      prompts.push(prompt);
      return { model: 'm', output: BODY('\n## Verification\n\n- Run `npm test`.\n'), cost: null };
    };
    await runDraftCommand({}, async () => runModel);
    expect(prompts[0]).toContain('idea from stdin');
  });

  it('reads --file, prints the draft and resolves for a ready draft', async () => {
    const dir = await tempDirs.make('draft-cmd-');
    const file = join(dir, 'idea.txt');
    writeFileSync(file, 'do the thing');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runModel = vi.fn(async () => ({
      model: 'm',
      output: BODY('\n## Verification\n\n- Run `npm test`.\n'),
      cost: null,
    }));
    await runDraftCommand({ file }, async () => runModel);
    expect(log).toHaveBeenCalledTimes(1);
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it('exits 1 for a draft that stays not ready', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runModel = vi.fn(async () => ({ model: 'm', output: BODY(''), cost: 0 }));
    const err = await runDraftCommand({ text: 'x' }, async () => runModel).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).code).toBe(1);
  });

  it('exits 2 for an input error and rethrows unknown errors', async () => {
    const usage = await runDraftCommand({ text: 'x', file: 'f' }, async () => async () => ({
      model: 'm',
      output: '',
      cost: null,
    })).catch((e: unknown) => e);
    expect((usage as CliExitError).code).toBe(2);
    const boom = new Error('boom');
    const other = await runDraftCommand({ text: 'x' }, async () => {
      throw boom;
    }).catch((e: unknown) => e);
    expect(other).toBe(boom);
  });
});
