import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cli entrypoint', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./cli-run.js');
    vi.restoreAllMocks();
  });

  it('runs main with process.argv and exits with its returned code', async () => {
    const main = vi.fn(async () => 0);
    vi.doMock('./cli-run.js', () => ({ main }));
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('./cli.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));

    expect(main).toHaveBeenCalledTimes(1);
  });

  it('prints the error and exits 2 when main rejects', async () => {
    const main = vi.fn(async () => {
      throw new Error('entry failed');
    });
    vi.doMock('./cli-run.js', () => ({ main }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('./cli.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(2));

    expect(console.error).toHaveBeenCalledWith('entry failed');
  });

  it('stringifies a non-Error rejection before printing it', async () => {
    const main = vi.fn(async () => {
      throw 'entry failed as a string';
    });
    vi.doMock('./cli-run.js', () => ({ main }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('./cli.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(2));

    expect(console.error).toHaveBeenCalledWith('entry failed as a string');
  });
});
