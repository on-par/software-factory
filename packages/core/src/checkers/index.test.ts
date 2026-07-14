import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ConstitutionLoader } from '../constitutions/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import {
  accessibilityChecker,
  compileChecker,
  linksChecker,
  runAllCheckers,
  runCustomChecker,
  testsChecker,
  type CheckerContext,
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
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })));
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
});

describe('testsChecker', () => {
  it('passes and skips when no test command is found', async () => {
    const worktree = await makeWorktree({
      'package.json': '{"name":"fixture","version":"1.0.0"}',
    });

    const result = await testsChecker(makeContext(worktree));

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('no test command found');
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

    expect(result.result).toBe('PASS');
    expect(result.details).toContain('no test command found');
  });
});

describe('linksChecker', () => {
  // linksChecker shells out to `paste -sd+`, whose stdin-with-no-file-argument
  // behavior differs between BSD paste (macOS) and GNU paste (CI). Stub it with
  // a Node script so these tests assert linksChecker's own logic consistently
  // across platforms rather than the host's paste implementation.
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'checker-test-bin-'));
    tempDirs.add(binDir);
    const pastePath = join(binDir, 'paste');
    await writeFile(
      pastePath,
      '#!/usr/bin/env node\n' +
        '(async () => {\n' +
        "  const input = await new Promise(resolve => { let data = ''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => resolve(data)); });\n" +
        "  const lines = String(input).split(/\\r?\\n/).filter(Boolean);\n" +
        "  process.stdout.write(lines.join('+') + (lines.length ? '\\n' : ''));\n" +
        '})();\n',
    );
    await chmod(pastePath, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

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

  it('fails when a regex-matched verdict cannot be parsed as JSON', async () => {
    const worktree = await makeWorktree();
    const { router } = makeRouter('{"checker": custom_x, "result": PASS}');

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('FAIL');
    expect(result.details).toBe('checker agent failed');
  });

  it('fails when the router fails', async () => {
    const worktree = await makeWorktree();
    const stub = new StubModelExecutor({ scripts: { check_custom: [{ fail: 'error' }] } });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await runCustomChecker(makeContext(worktree), 'custom_x', router);

    expect(result.result).toBe('FAIL');
    expect(result.details).toBe('checker agent failed');
  });
});

describe('runAllCheckers', () => {
  it('aggregates built-ins and custom checkers while skipping unknown checker names', { timeout: 60000 }, async () => {
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

    expect(summary.total).toBe(6);
    expect(summary.passes + summary.failures).toBe(summary.total);
    expect(summary.results.map(result => result.checker)).toContain('custom_style');
    expect(summary.results.map(result => result.checker)).not.toContain('not_a_real_checker');
  });

  it('runs only built-ins when no constitution is resolved', { timeout: 60000 }, async () => {
    const worktree = await makeWorktree();
    const stub = new StubModelExecutor({
      scripts: { check_custom: [{ output: '{"checker":"custom_style","result":"PASS","details":"ok"}' }] },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const summary = await runAllCheckers(makeContext(worktree), router, null);

    expect(summary.total).toBe(5);
    expect(stub.calls).toHaveLength(0);
  });
});
