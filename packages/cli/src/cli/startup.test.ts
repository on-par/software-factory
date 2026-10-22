// Startup budget for the light CLI paths (#3251): runs the built dist/cli.js, so `npm run build` must come first.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }
).version;
const HEAVY = /node_modules\/(@on-par\/factory-(core|tui)|ink|react|execa|zod)\/|packages\/(core|tui)\//;
const ENGINE = /node_modules\/(@on-par\/factory-tui|ink|react|execa|zod)\/|packages\/tui\//;

const tempDirs = createTempDirs();
let dir = '';
let countHook = '';
let denyHook = '';

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('run npm run build first');
  dir = tempDirs.makeSync('factory-startup-');
  countHook = join(dir, 'count-hook.mjs');
  denyHook = join(dir, 'deny-hook.mjs');
  writeFileSync(
    countHook,
    `import { registerHooks } from 'node:module';
const seen = [];
registerHooks({ load(url, ctx, next) { seen.push(url); return next(url, ctx); } });
process.on('exit', () => process.stderr.write('\\nLOADED:' + JSON.stringify(seen)));
`,
  );
  writeFileSync(
    denyHook,
    `import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const deny = () => process.exit(97);
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[k] = deny;
syncBuiltinESMExports();
require('node:net').Socket.prototype.connect = deny;
`,
  );
});

afterAll(async () => {
  await tempDirs.cleanup();
});

const env = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' };

function loadedFiles(args: string[]): { stdout: string; files: string[] } {
  const r = spawnSync(process.execPath, ['--import', countHook, CLI, ...args], { env, encoding: 'utf8' });
  expect(r.status).toBe(0);
  const marker = r.stderr.lastIndexOf('LOADED:');
  const urls = JSON.parse(r.stderr.slice(marker + 'LOADED:'.length)) as string[];
  return { stdout: r.stdout, files: urls.filter((u) => u.startsWith('file:')) };
}

describe('startup module budget', () => {
  it.each([['--version'], ['-V']])('%s loads fewer than 20 files and no engine/tui modules', (flag) => {
    const { stdout, files } = loadedFiles([flag]);
    expect(stdout.trim()).toBe(VERSION);
    expect(files.length).toBeLessThan(20);
    expect(files.filter((f) => HEAVY.test(f))).toEqual([]);
  });

  it.each([[['--help']], [[]]])(
    '%j loads fewer than 100 files and no tui/ink/execa/zod/factory-core barrel',
    (args) => {
      const { files } = loadedFiles(args);
      expect(files.length).toBeLessThan(100);
      expect(files.filter((f) => ENGINE.test(f))).toEqual([]);
      const core = files.filter((f) => /@on-par\/factory-core\/|packages\/core\//.test(f));
      expect(core.every((f) => /\/(dist|src)\/constants\.(js|ts)$/.test(f))).toBe(true);
    },
  );
});

describe('startup side effects', () => {
  it.each([['--version'], ['-V'], ['--help'], ['tui', '--help']])(
    '%s exits 0 under a spawn/connect-denying preload',
    (...args) => {
      const out = execFileSync(process.execPath, ['--import', denyHook, CLI, ...args], { env, encoding: 'utf8' });
      if (args[0] === '--version' || args[0] === '-V') expect(out.trim()).toBe(VERSION);
    },
  );
});

describe('compile cache', () => {
  it('dist/cli.js calls enableCompileCache before its dynamic import and never imports ./cli/index.js directly', () => {
    const src = readFileSync(CLI, 'utf8');
    const cache = src.indexOf('enableCompileCache');
    expect(cache).toBeGreaterThanOrEqual(0);
    expect(cache).toBeLessThan(src.indexOf('import('));
    expect(src).not.toContain('./cli/index.js');
  });
});
