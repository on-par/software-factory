import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cli entrypoint', () => {
  const originalExit = process.exit;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./cli/index.js');
    vi.restoreAllMocks();
    process.exit = originalExit;
  });

  it('runs main when the executable module loads', async () => {
    const main = vi.fn(async () => {});
    vi.doMock('./cli/index.js', () => ({ main }));

    await import('./cli.js');

    expect(main).toHaveBeenCalledTimes(1);
  });

  it('prints the error and exits 1 when main rejects', async () => {
    const main = vi.fn(async () => {
      throw new Error('entry failed');
    });
    vi.doMock('./cli/index.js', () => ({ main }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await import('./cli.js');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));

    expect(console.error).toHaveBeenCalledWith('entry failed');
  });
});
