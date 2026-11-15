import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';

import type { CheckKind, ChecksConfig } from '../config/checks-section.js';
import { extractJsonObjects } from '../utils/json.js';
import { tokenizeEvidenceCommand } from './evidence-allowlist.js';
import { fileExists } from './probe.js';

export type CheckProposal = ChecksConfig;

export const CHECK_KINDS: readonly CheckKind[] = ['build', 'test', 'lint'];

export interface CheckHeuristics {
  guessed: CheckProposal;
  documented: CheckProposal;
  ambiguities: string[];
}

const DOC_NAMES = ['readme.md', 'readme', 'agents.md', 'claude.md', 'contributing.md'];
const SCRIPT_LAUNCHERS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'zsh', 'node', 'python', 'python3']);
const SCRIPT_EXT = /\.(ps1|sh|bash|cmd|bat|py|mjs|js)$/i;
const KIND_PATTERNS: readonly [CheckKind, RegExp][] = [
  ['test', /test/i],
  ['lint', /lint|format/i],
  ['build', /build|compile/i],
];

function quoteToken(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}

interface Ecosystem {
  name: string;
  proposal: CheckProposal;
}

const NPM_PLACEHOLDER_TEST = /no test specified/i;

async function nodeProposal(repoRoot: string, entries: readonly string[]): Promise<CheckProposal> {
  if (!entries.includes('package.json')) return {};
  let scripts: unknown;
  try {
    const pkg: unknown = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8'));
    scripts = typeof pkg === 'object' && pkg !== null ? (pkg as { scripts?: unknown }).scripts : undefined;
  } catch {
    return {};
  }
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return {};
  const s = scripts as Record<string, unknown>;
  const has = (k: string): boolean => typeof s[k] === 'string' && (s[k] as string).trim() !== '';
  const proposal: CheckProposal = {};
  if (has('build')) proposal.build = 'npm run build';
  const checkPrefersVerifyScriptOverNpmTest =
    (await fileExists(join(repoRoot, 'scripts/verify.sh'))) || (await fileExists(join(repoRoot, 'scripts/verify.ps1')));
  if (has('test') && !NPM_PLACEHOLDER_TEST.test(s.test as string) && !checkPrefersVerifyScriptOverNpmTest)
    proposal.test = 'npm test';
  if (has('lint')) proposal.lint = 'npm run lint';
  return proposal;
}

async function guessEcosystems(
  repoRoot: string,
  entries: readonly string[],
  ambiguities: string[],
): Promise<Ecosystem[]> {
  const found: Ecosystem[] = [];
  const solutions = entries.filter((name) => /\.(sln|slnx)$/i.test(name)).sort();
  const projects = entries.filter((name) => /\.(csproj|fsproj|vbproj)$/i.test(name)).sort();
  if (solutions.length > 1) {
    ambiguities.push(`several solution files at the root (${solutions.join(', ')})`);
  } else {
    const target = solutions[0] ?? (projects.length === 1 ? projects[0] : undefined);
    if (target) {
      const t = quoteToken(target);
      const editorconfigStyleRulesEnforcedByDotnetFormat = entries.includes('.editorconfig');
      const lint = editorconfigStyleRulesEnforcedByDotnetFormat
        ? { lint: `dotnet format ${t} --verify-no-changes` }
        : {};
      found.push({ name: '.NET', proposal: { build: `dotnet build ${t}`, test: `dotnet test ${t}`, ...lint } });
    } else if (projects.length > 1) {
      ambiguities.push(`several project files at the root and no solution (${projects.join(', ')})`);
    }
  }
  if (entries.includes('go.mod')) {
    found.push({ name: 'Go', proposal: { build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' } });
  }
  if (entries.includes('Cargo.toml')) {
    found.push({ name: 'Rust', proposal: { build: 'cargo build', test: 'cargo test' } });
  }
  if (entries.includes('gradlew') && (await fileExists(join(repoRoot, 'gradlew')))) {
    found.push({ name: 'Gradle', proposal: { build: './gradlew assemble', test: './gradlew test' } });
  } else if (entries.includes('pom.xml')) {
    found.push({ name: 'Maven', proposal: { build: 'mvn -B compile', test: 'mvn -B test' } });
  }
  const noOtherBuildSystemSoPackageJsonIsTheFallback = found.length === 0;
  if (noOtherBuildSystemSoPackageJsonIsTheFallback) {
    const node = await nodeProposal(repoRoot, entries);
    if (Object.keys(node).length > 0) found.push({ name: 'Node', proposal: node });
  }
  return found;
}

function docCommandLines(text: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) lines.push(raw);
    else for (const m of raw.matchAll(/`([^`\n]+)`/g)) lines.push(m[1]!);
  }
  return lines.map((line) => line.trim().replace(/^(\$|>|PS>|PS [^>]*>)\s+/, ''));
}

async function scriptOf(repoRoot: string, argv: readonly string[]): Promise<string | null> {
  const launcher = argv[0]!;
  const candidate = SCRIPT_LAUNCHERS.has(launcher)
    ? argv.slice(1).find((token) => !token.startsWith('-'))
    : launcher.includes('/') || SCRIPT_EXT.test(launcher)
      ? launcher
      : undefined;
  if (candidate === undefined || isAbsolute(candidate)) return null;
  const rel = normalize(candidate);
  if (rel.startsWith('..') || rel.split(sep).includes('..')) return null;
  return (await fileExists(join(repoRoot, rel))) ? rel : null;
}

async function docFiles(repoRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const dir of ['', 'docs']) {
    const names = (await readdir(join(repoRoot, dir)).catch(() => [] as string[])).sort();
    for (const doc of DOC_NAMES) {
      const name = names.find((n) => n.toLowerCase() === doc);
      if (name !== undefined) files.push(dir ? `${dir}/${name}` : name);
    }
  }
  return files;
}

async function documentedCommands(repoRoot: string): Promise<CheckProposal> {
  const documented: CheckProposal = {};
  for (const file of await docFiles(repoRoot)) {
    const text = await readFile(join(repoRoot, file), 'utf-8').catch(() => null);
    if (text === null) continue;
    for (const line of docCommandLines(text)) {
      const argv = tokenizeEvidenceCommand(line);
      if (!argv) continue;
      const script = await scriptOf(repoRoot, argv);
      if (!script) continue;
      const kind = KIND_PATTERNS.find(([, pattern]) => pattern.test(script))?.[0];
      if (kind && documented[kind] === undefined) documented[kind] = line;
    }
  }
  return documented;
}

export async function detectCheckHeuristics(repoRoot: string): Promise<CheckHeuristics> {
  const entries = await readdir(repoRoot).catch(() => [] as string[]);
  const ambiguities: string[] = [];
  const ecosystems = await guessEcosystems(repoRoot, entries, ambiguities);
  if (ecosystems.length > 1) ambiguities.push(`several build systems (${ecosystems.map((e) => e.name).join(', ')})`);
  const guessed = ecosystems[0]?.proposal ?? {};
  const documented = await documentedCommands(repoRoot);
  for (const kind of CHECK_KINDS) {
    const doc = documented[kind];
    if (doc !== undefined && guessed[kind] !== undefined && doc !== guessed[kind]) {
      ambiguities.push(`the docs run \`${doc}\` for ${kind}, not \`${guessed[kind]}\``);
    }
  }
  if (guessed.test === undefined && documented.test === undefined) ambiguities.push('no test command found');
  return { guessed, documented, ambiguities };
}

export function heuristicProposal(h: CheckHeuristics): CheckProposal {
  return { ...h.guessed, ...h.documented };
}

const MAX_FILE_CHARS = 6000;
const MAX_TOTAL_CHARS = 60_000;
const MAX_DIR_FILES = 12;

async function listFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: string[] = [];
  for (const name of names.sort()) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info?.isFile()) files.push(name);
  }
  return files.slice(0, MAX_DIR_FILES);
}

export async function detectionSourceFiles(repoRoot: string): Promise<string[]> {
  const files = [...(await docFiles(repoRoot)), 'Makefile', 'package.json', 'build.ps1', 'build.sh', 'global.json'];
  for (const dir of ['.github/workflows', 'scripts', '.githooks', 'build', 'eng']) {
    for (const name of await listFiles(join(repoRoot, dir))) files.push(`${dir}/${name}`);
  }
  const present: string[] = [];
  for (const file of files) if (await fileExists(join(repoRoot, file))) present.push(file);
  return present;
}

export async function buildDetectChecksPrompt(repoRoot: string, h: CheckHeuristics): Promise<string> {
  const entries = (await readdir(repoRoot).catch(() => [] as string[])).sort();
  const sections: string[] = [];
  let budget = MAX_TOTAL_CHARS;
  for (const file of await detectionSourceFiles(repoRoot)) {
    if (budget <= 0) break;
    const text = (await readFile(join(repoRoot, file), 'utf-8').catch(() => '')).slice(
      0,
      Math.min(MAX_FILE_CHARS, budget),
    );
    budget -= text.length;
    sections.push(`--- ${file} ---\n${text}`);
  }
  return [
    'You find the commands that build, test and lint this repository, for an automated checker that runs them from the repo root after every change.',
    '',
    'Rules:',
    '- Prefer the commands the docs and CI workflows actually use over generic guesses.',
    '- Each command is ONE shell-free command line: no pipes, redirects, `;`, `&&`, `$VARS`, backticks, globs or `VAR=value` prefixes. If the real flow needs a shell, point at the script that does it.',
    '- The test command must run the test suite and exit non-zero when a test fails.',
    '- Use null for a kind the repo has no command for. Never invent a script that is not in the files below.',
    '',
    'Reply with exactly one JSON object and nothing else:',
    '{"build": "<command>" | null, "test": "<command>" | null, "lint": "<command>" | null, "notes": "<one sentence on where each came from>"}',
    '',
    `Root entries: ${entries.join(', ')}`,
    `Heuristic guess: ${JSON.stringify(h.guessed)}`,
    `Commands the docs show for repo scripts: ${JSON.stringify(h.documented)}`,
    `Why the heuristics are not enough: ${h.ambiguities.join('; ') || 'n/a'}`,
    '',
    ...sections,
  ].join('\n');
}

export interface DetectedChecks {
  proposal: CheckProposal;
  notes?: string;
  rejected: string[];
}

export function parseDetectedChecks(output: string): DetectedChecks | null {
  const objects = extractJsonObjects(output)
    .map((c) => c.value)
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v))
    .filter((v) => CHECK_KINDS.some((kind) => kind in v));
  const reply = objects.at(-1);
  if (!reply) return null;
  const proposal: CheckProposal = {};
  const rejected: string[] = [];
  for (const kind of CHECK_KINDS) {
    const value = reply[kind];
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (tokenizeEvidenceCommand(value.trim())) proposal[kind] = value.trim();
    else rejected.push(`${kind}: ${value}`);
  }
  return { proposal, rejected, ...(typeof reply.notes === 'string' ? { notes: reply.notes } : {}) };
}
