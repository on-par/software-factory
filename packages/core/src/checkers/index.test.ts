import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ConstitutionLoader } from '../constitutions/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { Constitution } from '../types/index.js';
import {
  accessibilityChecker,
  type CheckerContext,
  compileChecker,
  fileExists,
  linksChecker,
  lintChecker,
  runAllCheckers,
  runCustomChecker,
  testsChecker,
} from './index.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    check_custom: { tier: 'boss', description: 'stub' },
  },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function makeWorktree(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'checker-test-'));
  tempDirs.add(dir);

  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(dir, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }

  return dir;
}

function makeContext(worktree: string): CheckerContext {
  return {
    worktree,
    specPath: join(worktree, 'no-such-spec.md'),
    constitutionBody: 'test constitution',
  };
}

function makeRouter(output: string): { router: ModelRouter; stub: StubModelExecutor } {
  const stub = new StubModelExecutor({ scripts: { check_custom: [{ output }] } });
  return { router: new ModelRouter(models, routes, false, stub), stub };
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** npx resolves tsc by walking up from cwd — symlink the repo's real typescript install into the worktree. */
async function linkTypescript(worktree: string): Promise<void> {
  const binDir = join(worktree, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  await symlink(join(repoRoot, 'node_modules', 'typescript'), join(worktree, 'node_modules', 'typescript'), 'dir');
  await symlink(join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), join(binDir, 'tsc'), 'file');
}

describe('compileChecker', () => {
  it('passes when npm run build exits successfully', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0","scripts":{"build":"node -e \\"process.exit(0)\\""}}',
    });

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('npm run build: OK');
  });

  it('fails when npm run build exits unsuccessfully', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0","scripts":{"build":"node -e \\"process.exit(1)\\""}}',
    });

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('npm run build failed');
  });

  it('passes when there is no package.json and no other build system detected', async () => {
    const worktree = await makeWorktree();

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('no build system detected — skipped');
  });

  it('fails closed when package.json cannot be read', async () => {
    const worktree = await makeWorktree();
    await mkdir(join(worktree, 'package.json'));

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('unexpected checker error');
  });

  it('fails closed on malformed package.json', async () => {
    const worktree = await makeWorktree({ 'package.json': '{not json' });

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('unexpected checker error');
  });

  it('fails when a Makefile is present and make fails', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      Makefile: 'all:\n\texit 1\n',
    });

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('make failed');
  });

  it('passes when a Makefile is present and make succeeds', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      Makefile: 'all:\n\t@true\n',
    });

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('make: OK');
  });

  it('fails when Cargo.toml is present and cargo build fails', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      'Cargo.toml': 'this is not [[[ valid cargo manifest',
    });

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('cargo build failed');
  });

  it('skips when package.json has no build script and no other manifest exists', async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0"}',
    });

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('no build system detected — skipped');
  });

  it('prefers make over cargo when both manifests are present', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      Makefile: 'all:\n\texit 1\n',
      'Cargo.toml': 'this is not [[[ valid cargo manifest',
    });

    const result = await compileChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('make failed');
  });
});

describe('testsChecker', () => {
  it('skips when no test command is found', async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0"}',
    });

    const result = await testsChecker(makeContext(worktree));

    expect(result.result).toBe('SKIP');
    expect(result.details).toContain('no verification command was run');
  });

  it('fails when testsRequired is set and no test command is found', async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0"}',
    });

    const result = await testsChecker({ ...makeContext(worktree), testsRequired: true });

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('requireTests');
    expect(result.details).toContain('no verification command was run');
  });

  it('still passes when testsRequired is set and scripts/verify.sh succeeds', async () => {
    const worktree = await makeWorktree({
      'scripts/verify.sh': '#!/bin/bash\nexit 0',
    });

    const result = await testsChecker({ ...makeContext(worktree), testsRequired: true });

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('verify.sh');
  });

  it('passes through scripts/verify.sh', async () => {
    const worktree = await makeWorktree({
      'scripts/verify.sh': '#!/bin/bash\nexit 0',
    });

    const result = await testsChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('verify.sh');
  });

  it('fails through scripts/verify.sh', async () => {
    const worktree = await makeWorktree({
      'scripts/verify.sh': '#!/bin/bash\nexit 1',
    });

    const result = await testsChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
  });

  it('uses shared package.json from context instead of re-reading from disk', async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(1)\\""}}',
    });

    const result = await testsChecker({ ...makeContext(worktree), packageJson: { scripts: {} } });

    expect(result.result).toBe('SKIP');
    expect(result.details).toContain('no verification command was run');
  });

  it('fails closed when package.json cannot be read', async () => {
    const worktree = await makeWorktree();
    await mkdir(join(worktree, 'package.json'));

    const result = await testsChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('unexpected checker error');
  });

  it('passes when npm test exits successfully and no scripts/verify.sh is present', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}',
    });

    const result = await testsChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('npm test: OK');
  });

  it('fails when npm test exits unsuccessfully and no scripts/verify.sh is present', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(1)\\""}}',
    });

    const result = await testsChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('npm test failed');
  });
});

describe('lintChecker', () => {
  it('passes when npm run lint exits successfully', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0","scripts":{"lint":"node -e \\"process.exit(0)\\""}}',
    });

    const result = await lintChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('eslint: OK');
  });

  it('fails when npm run lint exits unsuccessfully', { timeout: 30000 }, async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0","scripts":{"lint":"node -e \\"process.exit(1)\\""}}',
    });

    const result = await lintChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('eslint failed');
  });

  it('passes tsc --noEmit against a type-correct tsconfig project', { timeout: 60000 }, async () => {
    const worktree = await makeWorktree({
      'tsconfig.json': '{"compilerOptions":{"strict":true,"noEmit":true},"include":["index.ts"]}',
      'index.ts': 'export const x: number = 1;\n',
    });
    await linkTypescript(worktree);

    const result = await lintChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('tsc: OK');
  });

  it('fails tsc --noEmit against a project with a real type error', { timeout: 60000 }, async () => {
    const worktree = await makeWorktree({
      'tsconfig.json': '{"compilerOptions":{"strict":true,"noEmit":true},"include":["index.ts"]}',
      'index.ts': 'export const x: number = "not a number";\n',
    });
    await linkTypescript(worktree);

    const result = await lintChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('tsc failed');
  });

  it('reports skipped when no lint script and no tsconfig.json are present', async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0"}',
    });

    const result = await lintChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('no linting configured — skipped');
  });
});

describe('linksChecker', () => {
  it('passes and skips when no HTML files exist', async () => {
    const worktree = await makeWorktree();

    const result = await linksChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('no HTML files');
  });

  it('fails when placeholder links exist', async () => {
    const worktree = await makeWorktree({
      'index.html': '<html><body><a href="#">click</a></body></html>',
    });

    const result = await linksChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.broken).toBeGreaterThanOrEqual(1);
    expect(result.details).toContain('placeholder');
  });

  it('passes when HTML links are non-placeholder links', async () => {
    const worktree = await makeWorktree({
      'index.html': '<html><body><a href="https://example.com">ok</a></body></html>',
    });

    const result = await linksChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
  });

  describe('treats crafted file paths as data, never shell', () => {
    const adversarialNames = [
      ['single quotes', "a'b'c.html"],
      ['double quotes', 'a"b"c.html'],
      ['semicolons', 'a;touch pwned;b.html'],
      ['dollar command substitution', 'a$(touch pwned).html'],
      ['backtick command substitution', 'a`touch pwned`.html'],
      ['combined metacharacters', "a'b $(touch pwned); `touch pwned`.html"],
    ] as const;

    it.each(adversarialNames)('handles a filename with %s without executing it', async (_label, name) => {
      const worktree = await makeWorktree({
        [name]: '<html><body><a href="#">click</a><a href="https://example.com">ok</a></body></html>',
      });

      const result = await linksChecker(makeContext(worktree));

      // The file was read as data: its placeholder link was counted.
      expect(result.result).toBe('FAIL');
      expect(result.broken).toBeGreaterThanOrEqual(1);
      // No command execution side effect anywhere plausible.
      expect(await fileExists(join(worktree, 'pwned'))).toBe(false);
      expect(await fileExists(join(process.cwd(), 'pwned'))).toBe(false);
    });

    it('handles metacharacters in directory names during traversal', async () => {
      const worktree = await makeWorktree({
        'evil $(touch pwned); dir/index.html': '<a href="https://example.com">ok</a>',
      });

      const result = await linksChecker(makeContext(worktree));

      expect(result.result).toBe('PASS');
      expect(result.linksChecked).toBe(1);
      expect(await fileExists(join(worktree, 'pwned'))).toBe(false);
      expect(await fileExists(join(process.cwd(), 'pwned'))).toBe(false);
    });
  });

  it('silently skips a subdirectory that cannot be read during traversal', async () => {
    const worktree = await makeWorktree({
      'index.html': '<a href="https://example.com">ok</a>',
      'locked/inner.html': '<a href="#">nope</a>',
    });
    const lockedDir = join(worktree, 'locked');
    await chmod(lockedDir, 0o000);

    try {
      const result = await linksChecker(makeContext(worktree));

      expect(result.result).toBe('PASS');
      expect(result.linksChecked).toBe(1);
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });

  it('deduplicates URLs across files and excludes non-http-ish/fragment links', async () => {
    const worktree = await makeWorktree({
      'a.html':
        '<a href="https://example.com/shared">shared</a><a href="mailto:x@example.com">mail</a><a href="#section">frag</a>',
      'b.html':
        '<a href="https://example.com/shared">shared</a><a href="tel:+15551234567">tel</a><a href="javascript:void(0)">js</a><a href="data:text/plain,x">data</a>',
    });

    const result = await linksChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.linksChecked).toBe(1);
  });
});

describe('accessibilityChecker', () => {
  it('counts images without alt text and placeholder links from HTML files', async () => {
    const worktree = await makeWorktree({
      'a.html': '<img src="a.png">\n<a href="#">x</a>\n<a href="#">y</a>',
      'b.html': '<img src="b.png"><img src="c.png" alt="ok">\n<a href="#">z</a>',
      'c.html': '<img src="d.png">\n<img src="e.png">',
      'd.html': '<img src="f.png" alt="ok">',
      'e.html': '<a href="/ok">ok</a>',
      'f.html': '<main>clean</main>',
      'nested/g.html': '<img src="g.png">\n<a href="#">nested</a>',
      'nested/h.html': '<img src="h.png" alt="ok">',
      'nested/i.html': '<a href="/fine">fine</a>',
      'nested/j.html': '<section>also clean</section>',
    });

    const result = await accessibilityChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('a.html: 1 images without alt');
    expect(result.details).toContain('a.html: 2 placeholder links');
    expect(result.details).toContain('b.html: 1 images without alt');
    expect(result.details).toContain('b.html: 1 placeholder links');
    expect(result.details).toContain('c.html: 2 images without alt');
    expect(result.details).toContain('nested/g.html: 1 images without alt');
    expect(result.details).toContain('nested/g.html: 1 placeholder links');
    expect(result.details).toContain('browser-based axe-core recommended');
  });

  it('passes when basic accessibility checks find no issues', async () => {
    const worktree = await makeWorktree({
      'index.html': '<img src="a.png" alt="ok">\n<a href="/ok">ok</a>',
      'nested/page.html': '<main><img src="b.png" alt="also ok"></main>',
    });

    const result = await accessibilityChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('basic checks passed');
    expect(result.details).not.toContain('not scanned');
  });

  it('ignores generated-output dirs like coverage reports embedding source markup', async () => {
    const worktree = await makeWorktree({
      'index.html': '<img src="a.png" alt="ok">\n<a href="/ok">ok</a>',
      'coverage/core/src/checkers/index.ts.html': '<img src="a.png">\n<a href="#">x</a>\n<a href="#">y</a>',
      'dist/index.html': '<a href="#">z</a>',
    });

    const result = await accessibilityChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('basic checks passed');
  });

  it('reports truncation when more than 20 HTML files exist', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      const name = `f${String(i).padStart(2, '0')}.html`;
      files[name] = '<main>clean</main>';
    }
    const worktree = await makeWorktree(files);

    const result = await accessibilityChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('first 20 of 25');
    expect(result.details).toContain('5 not scanned');
    expect(result.details).toContain('basic checks passed');
  });

  it('does not hide that unscanned files were skipped when the issue is beyond the cap', async () => {
    const files: Record<string, string> = {
      'z-broken.html': '<img src="x.png">',
    };
    for (let i = 0; i < 20; i++) {
      const name = `a${String(i).padStart(2, '0')}.html`;
      files[name] = '<main>clean</main>';
    }
    const worktree = await makeWorktree(files);

    const result = await accessibilityChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('first 20 of 21');
    expect(result.details).toContain('1 not scanned');
  });

  it('deterministically scans the lexicographically-first files, reporting truncation on the FAIL path', async () => {
    const files: Record<string, string> = {
      'a-bad.html': '<img src="x.png">',
    };
    for (let i = 0; i < 20; i++) {
      const name = `m${String(i).padStart(2, '0')}.html`;
      files[name] = '<main>clean</main>';
    }
    const worktree = await makeWorktree(files);

    const result = await accessibilityChecker(makeContext(worktree));

    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('a-bad.html: 1 images without alt');
    expect(result.details).toContain('first 20 of 21');
  });
});

describe('runCustomChecker', () => {
  it('parses a valid verdict and includes checker context in the prompt', async () => {
    const worktree = await makeWorktree();
    const { router, stub } = makeRouter('{"checker":"custom_x","result":"PASS","details":"all good"}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('PASS');
    expect(result.details).toBe('all good');
    expect(stub.calls[0].prompt).toContain('custom_x');
    expect(stub.calls[0].prompt).toContain('test constitution');
  });

  it('parses a verdict embedded in prose', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('Here is my verdict:\n{"checker":"custom_x","result":"FAIL","details":"bad"}\nDone.');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('FAIL');
  });

  it('parses a valid verdict whose details contain braces', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter(
      '{"checker":"custom_x","result":"PASS","details":"config must include {\\"strict\\": true} — found { strict: false }"}',
    );

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('{"strict": true}');
  });

  it('finds the verdict after prose containing code braces', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter(
      'I inspected function f() { return { a: 1 }; } and concluded:\n{"checker":"custom_x","result":"FAIL","details":"missing {config} block"}',
    );

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('FAIL');
    expect(result.details).toBe('missing {config} block');
  });

  it('preserves nested-JSON details', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"custom_x","result":"PASS","details":"saw {\\"a\\":{\\"b\\":1}}"}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('PASS');
    expect(result.details).toBe('saw {"a":{"b":1}}');
  });

  it('fails when prose contains no JSON verdict', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('I could not determine anything.');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/^checker produced no valid JSON/);
  });

  it('fails when JSON is truncated', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"custom_x","result":');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/^checker produced no valid JSON/);
  });

  it('fails with the raw output when pseudo-JSON cannot be parsed', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker": custom_x, "result": PASS}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/^checker produced no valid JSON/);
  });

  it('fails when the router fails', async () => {
    const worktree = await makeWorktree();
    const stub = new StubModelExecutor({ scripts: { check_custom: [{ fail: 'error' }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/^checker agent failed: /);
    expect(result.details).toContain('error');
  });

  it('fails closed on a lowercase result value', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"custom_x","result":"pass","details":"ok"}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.checker).toBe('custom_x');
    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/malformed verdict/);
    expect(result.details).toContain('"result":"pass"');
  });

  it('fails closed on an invalid result value', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"custom_x","result":"PASSED","details":"ok"}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.checker).toBe('custom_x');
    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/malformed verdict/);
    expect(result.details).toContain('"result":"PASSED"');
  });

  it('fails closed on a mismatched checker name', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"custom_other","result":"PASS","details":"ok"}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.checker).toBe('custom_x');
    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/malformed verdict/);
    expect(result.details).toContain('"checker":"custom_other"');
  });

  it('fails closed on a non-string checker name', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":42,"result":"PASS","details":"ok"}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.checker).toBe('custom_x');
    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/malformed verdict/);
    expect(result.details).toContain('"checker":42');
  });

  it('fails closed when a custom checker returns SKIP', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"custom_x","result":"SKIP","details":"ok"}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.checker).toBe('custom_x');
    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/malformed verdict/);
    expect(result.details).toContain('"result":"SKIP"');
  });

  it('fails closed on non-string details', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker":"custom_x","result":"PASS","details":42}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.checker).toBe('custom_x');
    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/malformed verdict/);
    expect(result.details).toContain('"details":42');
  });

  it('falls through to the no-valid-JSON path when the checker key is missing', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"result":"PASS","details":"ok"}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/^checker produced no valid JSON/);
  });
});

describe('runAllCheckers', () => {
  it(
    'aggregates built-ins and custom checkers and fails closed on unknown checker names',
    { timeout: 60000 },
    async () => {
      const constitutionDir = await mkdtemp(join(tmpdir(), 'checker-test-constitution-'));
      tempDirs.add(constitutionDir);
      await writeFile(
        join(constitutionDir, 'myproduct.md'),
        '---\nproduct: myproduct\ncheckers:\n  - custom_style\n  - not_a_real_checker\n---\nBody standard text\n',
      );
      const worktree = await makeWorktree();
      const stub = new StubModelExecutor({
        scripts: { check_custom: [{ output: '{"checker":"custom_style","result":"PASS","details":"ok"}' }] },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const constitution = new ConstitutionLoader(constitutionDir).resolve(worktree, 'myproduct');

      const summary = await runAllCheckers(makeContext(worktree), router, constitution);

      expect(summary.total).toBe(7); // 5 built-ins + custom_style + not_a_real_checker
      expect(summary.passes + summary.failures + summary.skips).toBe(summary.total);
      expect(summary.results.map((result) => result.checker)).toContain('custom_style');
      const unknown = summary.results.find((result) => result.checker === 'not_a_real_checker');
      expect(unknown?.result).toBe('FAIL');
      expect(unknown?.details).toContain('unknown checker');
      expect(summary.failures).toBeGreaterThanOrEqual(1);
    },
  );

  it('fails closed on an unknown checker alone, blocking a clean pass', { timeout: 60000 }, async () => {
    const constitutionDir = await mkdtemp(join(tmpdir(), 'checker-test-constitution-'));
    tempDirs.add(constitutionDir);
    await writeFile(
      join(constitutionDir, 'myproduct.md'),
      '---\nproduct: myproduct\ncheckers:\n  - ghost_checker\n---\nBody standard text\n',
    );
    const worktree = await makeWorktree();
    const { router, stub } = makeRouter('{"checker":"custom_x","result":"PASS","details":"ok"}');
    const constitution = new ConstitutionLoader(constitutionDir).resolve(worktree, 'myproduct');

    const summary = await runAllCheckers(makeContext(worktree), router, constitution);

    expect(summary.failures).toBeGreaterThanOrEqual(1);
    expect(summary.results.some((r) => r.checker === 'ghost_checker' && r.result === 'FAIL')).toBe(true);
    expect(stub.calls).toHaveLength(0); // unknown names must NOT be routed to the custom-checker agent
  });

  it('runs only built-ins when no constitution is resolved', { timeout: 60000 }, async () => {
    const worktree = await makeWorktree();
    const stub = new StubModelExecutor({
      scripts: { check_custom: [{ output: '{"checker":"custom_style","result":"PASS","details":"ok"}' }] },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runAllCheckers(makeContext(worktree), router, null);

    expect(summary.total).toBe(5);
    expect(summary.results.map((r) => r.checker)).toEqual(['compile', 'tests', 'lint', 'links', 'accessibility']);
    expect(stub.calls).toHaveLength(0);
  });

  it(
    'fails the tests checker when constitution.requireTests is true and no test command exists',
    { timeout: 60000 },
    async () => {
      const worktree = await makeWorktree();
      const { router } = makeRouter('{"checker":"custom_x","result":"PASS","details":"ok"}');
      const constitution: Constitution = {
        product: 'myproduct',
        version: 1,
        checkers: [],
        requireTests: true,
        body: 'Body standard text',
        path: worktree,
        source: 'bundled',
      };

      const summary = await runAllCheckers(makeContext(worktree), router, constitution);

      const tests = summary.results.find((r) => r.checker === 'tests');
      expect(tests?.result).toBe('FAIL');
      expect(summary.failures).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    'skips the tests checker and counts it in summary.skips when requireTests is not set',
    { timeout: 60000 },
    async () => {
      const worktree = await makeWorktree();
      const { router } = makeRouter('{"checker":"custom_x","result":"PASS","details":"ok"}');

      const summary = await runAllCheckers(makeContext(worktree), router, null);

      const tests = summary.results.find((r) => r.checker === 'tests');
      expect(tests?.result).toBe('SKIP');
      expect(summary.skips).toBe(1);
      expect(summary.total).toBe(5);
      expect(summary.failures + summary.passes + summary.skips).toBe(summary.total);
    },
  );

  it('does not throw and fails closed when package.json is unreadable', { timeout: 60000 }, async () => {
    const worktree = await makeWorktree();
    await mkdir(join(worktree, 'package.json'));
    const { router } = makeRouter('{"checker":"custom_x","result":"PASS","details":"ok"}');

    const summary = await runAllCheckers(makeContext(worktree), router, null);

    expect(summary.failures).toBeGreaterThanOrEqual(3);
    for (const name of ['compile', 'tests', 'lint']) {
      const output = summary.results.find((r) => r.checker === name);
      expect(output?.result).toBe('FAIL');
    }
  });
});

describe('fileExists', () => {
  it('returns true for an existing regular file', async () => {
    const worktree = await makeWorktree({ 'scripts/verify.sh': 'exit 0' });
    expect(await fileExists(join(worktree, 'scripts/verify.sh'))).toBe(true);
  });

  it('returns false for a missing path', async () => {
    const worktree = await makeWorktree();
    expect(await fileExists(join(worktree, 'no-such-file'))).toBe(false);
  });

  it('returns false for a directory', async () => {
    const worktree = await makeWorktree({ 'scripts/verify.sh': 'exit 0' });
    expect(await fileExists(join(worktree, 'scripts'))).toBe(false);
  });
});
