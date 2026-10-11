// scripts/pack-hygiene.ts — tarball hygiene for the published @on-par packages (#2336).
//
// Two jobs, one rule set:
//   prepack          run from a package dir by its `prepack` script; refuses to
//                    pack when dist/ was never built (a pack before a build used
//                    to ship a tarball holding only package.json).
//   verify <json> <list>
//                    checks `npm pack --json` output for every workspace named in
//                    <list> (scripts/publish-workspaces.txt): README.md, LICENSE
//                    and a built dist/ are present, nothing outside dist/ ships,
//                    and no test file, test-support kit or .tsbuildinfo leaks into a
//                    tarball.
//
// Plain erasable TypeScript so Node >= 24 runs it directly (`node scripts/...ts`)
// from a package's lifecycle script, with no tsx or build step in the way.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Package-root files every published tarball must carry. */
export const REQUIRED_PACK_FILES: readonly string[] = ['package.json', 'README.md', 'LICENSE'];

const TEST_FILE = /(^|\/)[^/]+\.test\.[^/]+$/;
const TEST_SUPPORT = /(^|\/)test-support\//;
const BUILD_INFO = /\.tsbuildinfo$/;

/** Problems with one package's tarball file list (paths relative to the package root). */
export function checkPackFiles(name: string, paths: readonly string[]): string[] {
  const problems: string[] = [];
  for (const required of REQUIRED_PACK_FILES) {
    if (!paths.includes(required)) problems.push(`${name}: tarball is missing ${required}`);
  }
  if (!paths.some((p) => p.startsWith('dist/'))) problems.push(`${name}: tarball has no dist/ files (not built?)`);
  for (const p of paths) {
    if (TEST_FILE.test(p)) problems.push(`${name}: tarball ships test file ${p}`);
    else if (TEST_SUPPORT.test(p)) problems.push(`${name}: tarball ships test-support file ${p}`);
    else if (BUILD_INFO.test(p)) problems.push(`${name}: tarball ships tsc build info ${p}`);
    else if (!REQUIRED_PACK_FILES.includes(p) && !p.startsWith('dist/')) {
      problems.push(`${name}: tarball ships ${p} from outside dist/`);
    }
  }
  return problems;
}

/** Problems that make a package directory unfit to pack: no build output, or no README/LICENSE. */
export function checkPackageDir(dir: string): string[] {
  const problems: string[] = [];
  const dist = join(dir, 'dist');
  if (!existsSync(dist) || readdirSync(dist).length === 0) {
    problems.push(`${dist} is missing or empty; run \`npm run build\` at the repo root before packing`);
  }
  for (const file of ['README.md', 'LICENSE']) {
    if (!existsSync(join(dir, file))) problems.push(`${join(dir, file)} is missing`);
  }
  return problems;
}

export interface PackEntry {
  name: string;
  files: string[];
}

/** Parse `npm pack --json` output into name + file paths, failing loudly on any other shape. */
export function parsePackJson(text: string): PackEntry[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('npm pack --json output is not an array');
  return data.map((entry: unknown) => {
    const e = entry as { name?: unknown; files?: unknown };
    if (typeof e?.name !== 'string' || !Array.isArray(e.files)) {
      throw new Error('npm pack --json entry is missing name or files');
    }
    return { name: e.name, files: e.files.map((f: { path?: unknown }) => String(f?.path)) };
  });
}

/** Workspace names from a publish list: one per line, blank lines ignored. */
export function parseWorkspaceList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Problems across a whole pack run: every listed package packed, and each one clean. */
export function verifyPack(entries: readonly PackEntry[], expected: readonly string[]): string[] {
  const problems: string[] = [];
  const packed = new Set(entries.map((e) => e.name));
  for (const name of expected) {
    if (!packed.has(name)) problems.push(`${name}: not in the pack output`);
  }
  for (const entry of entries) problems.push(...checkPackFiles(entry.name, entry.files));
  return problems;
}

export interface PackHygieneIo {
  cwd: string;
  readFile: (path: string) => string;
  err: (text: string) => void;
}

const USAGE = 'usage: pack-hygiene.ts prepack | verify <npm-pack.json> <publish-workspaces.txt>\n';

/** CLI entry; returns the process exit code. */
export function runPackHygiene(argv: readonly string[], io: PackHygieneIo): number {
  const [command, ...rest] = argv;
  let problems: string[];
  if (command === 'prepack' && rest.length === 0) {
    problems = checkPackageDir(io.cwd);
  } else if (command === 'verify' && rest.length === 2) {
    const [packJson, list] = rest as [string, string];
    problems = verifyPack(parsePackJson(io.readFile(packJson)), parseWorkspaceList(io.readFile(list)));
  } else {
    io.err(USAGE);
    return 2;
  }
  for (const problem of problems) io.err(`pack-hygiene: ${problem}\n`);
  return problems.length === 0 ? 0 : 1;
}
