import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAgentMemoryCtx, readAgentMemory } from '../agent-memory/index.js';
import { detectPythonTestSurface } from '../checkers/probe.js';
import { resolveTestsCommand } from '../checkers/resolve-commands.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { readProductInput, resolveProjectInput, type ProjectInput } from './project-inputs.js';

const tmp = createTempDirs();
afterEach(async () => {
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

function tree(prefix: string, files: Record<string, string>): string {
  const root = tmp.makeSync(prefix);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const checkoutFiles = {
  '.factory/agent-memory/core.md': 'checkout memory',
  '.factory/state/product': 'checkout-product',
  '.factory/tests/test_checkout.py': 'def test_checkout(): pass\n',
};

const externalFiles = {
  'agent-memory/core.md': 'external memory',
  product: 'external-product',
  'tests/test_external.py': 'def test_external(): pass\n',
};

const productPath = (checkout: string): string => join(checkout, '.factory', 'state', 'product');

function envFor(mode: 'external' | 'unset' | 'blank', external: string): NodeJS.ProcessEnv {
  if (mode === 'external') return { FACTORY_PROJECT_CONFIG_DIR: external };
  return mode === 'blank' ? { FACTORY_PROJECT_CONFIG_DIR: '  ' } : {};
}

function testsCtx(worktree: string) {
  return { worktree, packageJson: null, checks: null };
}

describe('project config directory inputs (#4339)', () => {
  it.each([
    { mode: 'external' as const, content: 'external memory', fromExternal: true },
    { mode: 'unset' as const, content: 'checkout memory', fromExternal: false },
    { mode: 'blank' as const, content: 'checkout memory', fromExternal: false },
  ])('agent-memory read from external directory ($mode)', async ({ mode, content, fromExternal }) => {
    const checkout = tree('pci-checkout-', checkoutFiles);
    const external = tree('pci-external-', externalFiles);
    const env = envFor(mode, external);

    const memory = await readAgentMemory(checkout, 'core', undefined, env);
    const prompt = await loadAgentMemoryCtx(checkout, 'core', vi.fn(), env);

    expect(memory).toMatchObject({ kind: 'loaded', content });
    const expectedPath = fromExternal
      ? join(external, 'agent-memory', 'core.md')
      : join(checkout, '.factory', 'agent-memory', 'core.md');
    expect(memory.path).toBe(expectedPath);
    expect(prompt).toContain(content);
    expect(prompt).toContain(fromExternal ? expectedPath : '.factory/agent-memory/core.md');
  });

  it.each([
    {
      mode: 'external' as const,
      product: 'external-product',
      sources: ['.factory/tests/'],
      testsArg: (external: string) => join(external, 'tests'),
    },
    {
      mode: 'unset' as const,
      product: 'checkout-product',
      sources: ['.factory/tests/'],
      testsArg: () => '.factory/tests',
    },
  ])('product and tests read from external directory ($mode)', async ({ mode, product, sources, testsArg }) => {
    const checkout = tree('pci-checkout-', checkoutFiles);
    const external = tree('pci-external-', externalFiles);
    for (const [key, value] of Object.entries(envFor(mode, external))) vi.stubEnv(key, value);

    const command = await resolveTestsCommand(testsCtx(checkout));

    expect(readProductInput(productPath(checkout))).toBe(product);
    expect(await detectPythonTestSurface(checkout)).toEqual({ present: true, sources });
    expect(command.argv).toEqual(['python3', '-m', 'pytest', testsArg(external)]);
  });

  it('product and tests read from external directory (external has none)', async () => {
    const checkout = tree('pci-checkout-', checkoutFiles);
    const external = tree('pci-external-', { 'config.yaml': 'version: 2\n' });
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', external);

    expect(readProductInput(productPath(checkout))).toBeUndefined();
    expect(await detectPythonTestSurface(checkout)).toEqual({ present: false, sources: [] });
    expect((await resolveTestsCommand(testsCtx(checkout))).runner).toBe('none');
  });

  it.each<{ input: ProjectInput; checkoutRel: string }>([
    { input: 'agent-memory', checkoutRel: '.factory/agent-memory' },
    { input: 'product', checkoutRel: '.factory/state/product' },
    { input: 'tests', checkoutRel: '.factory/tests' },
  ])('no checkout .factory reads when external source set ($input)', async ({ input, checkoutRel }) => {
    const checkout = tree('pci-checkout-', checkoutFiles);
    const external = tree('pci-external-', externalFiles);
    const env = { FACTORY_PROJECT_CONFIG_DIR: external };
    const checkoutFactory = join(checkout, '.factory') + sep;
    const isCheckout = (p: string): boolean => p.startsWith(checkoutFactory);
    const readFile = vi.fn((p: string) => (isCheckout(p) ? 'CHECKOUT-READ' : readFileSync(p, 'utf-8')));
    const fileExists = vi.fn((p: string) => !isCheckout(p));

    const location = resolveProjectInput(input, join(checkout, checkoutRel), env);
    const product = readProductInput(productPath(checkout), { env, readFile, fileExists });
    const memory = await readAgentMemory(checkout, 'core', undefined, env);
    vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', external);
    const command = await resolveTestsCommand(testsCtx(checkout));

    expect(location).toEqual({ path: join(external, input), external: true });
    expect(isCheckout(location.path)).toBe(false);
    expect(product).toBe('external-product');
    expect(memory).toMatchObject({ content: 'external memory' });
    expect(command.argv).toEqual(['python3', '-m', 'pytest', join(external, 'tests')]);
  });
});
