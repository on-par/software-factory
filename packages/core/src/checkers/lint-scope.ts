// src/checkers/lint-scope.ts — scope lint commands to the change: file lists, merge-base fallback, findings (#1898).

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { withTempDir } from '../harness/temp-dir.js';
import type { CommandResult, RunCommandOptions } from '../utils/command-runner.js';
import { GIT_COMMAND_TIMEOUT_MS } from '../utils/git-exec.js';
import { listChangedFiles, MAX_AFFECTED_FILES } from './affected-tests.js';
import { DEPENDENCY_INSTALL_TIMEOUT_MS, dependencyInstallCommand } from './dependency-install.js';
import { BASE_REF_CANDIDATES, defaultDiffRunner, type DiffRunner } from './design-smells.js';
import type { CheckerContext } from './index.js';
import type { LintCommand } from './resolve-commands.js';

export type LintFileListMode = 'replace-dot' | 'include-flag' | 'none';

export interface LintToolProfile {
  /** 'eslint', 'dotnet format', 'tsc', 'npm run lint', ... */
  tool: string;
  fileList: LintFileListMode;
  /** Lowercase, no dot. */
  extensions: readonly string[] | 'non-doc';
  /** Basename patterns; a changed match forces a whole-repo run. */
  configFiles: readonly RegExp[];
  /** Why this argv is write mode, or null when it is check mode. */
  writeMode(args: readonly string[]): string | null;
  /** The check-mode form to suggest when writeMode is non-null. */
  checkModeHint: string;
}

export type LintScope =
  | { kind: 'skip'; reason: string }
  | { kind: 'write-mode'; reason: string }
  | { kind: 'files'; argv: string[]; files: string[] }
  | { kind: 'whole'; argv: string[]; profile: LintToolProfile | null };

export interface LintFinding {
  file: string;
  line: number;
  rule: string;
}

export interface LintDiff {
  baseRef: string;
  mergeBase: string;
  changed: string[];
}

export const DOC_EXTENSIONS: readonly string[] = ['md', 'mdx', 'markdown', 'rst', 'txt', 'adoc'];

const JS_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'];
const never = (): null => null;
const hasAny = (args: readonly string[], flags: readonly string[]): boolean => flags.some((f) => args.includes(f));
const flagIs = (flag: string) => (args: readonly string[]) => (args.includes(flag) ? `${flag} is set` : null);
const lacksCheck = (flags: readonly string[]) => (args: readonly string[]) =>
  hasAny(args, flags) ? null : `no ${flags[0]}`;

const RUFF_CONFIG = [/^ruff\.toml$/, /^\.ruff\.toml$/, /^pyproject\.toml$/];

/** Keyed by how the tool is invoked once the launcher prefix is stripped. */
const LINT_TOOL_PROFILES: Record<string, LintToolProfile> = {
  eslint: {
    tool: 'eslint',
    fileList: 'replace-dot',
    extensions: [...JS_EXTENSIONS, 'vue'],
    configFiles: [/^eslint\.config\./, /^\.eslintrc/, /^\.eslintignore$/],
    writeMode: flagIs('--fix'),
    checkModeHint: 'eslint .',
  },
  prettier: {
    tool: 'prettier',
    fileList: 'replace-dot',
    extensions: [...JS_EXTENSIONS, 'json', 'css', 'scss', 'less', 'md', 'mdx', 'yaml', 'yml', 'html', 'vue', 'graphql'],
    configFiles: [/^\.prettierrc/, /^prettier\.config\./, /^\.prettierignore$/, /^\.editorconfig$/],
    writeMode: lacksCheck(['--check', '-c', '--list-different', '-l']),
    checkModeHint: 'prettier --check .',
  },
  'ruff check': {
    tool: 'ruff check',
    fileList: 'replace-dot',
    extensions: ['py', 'pyi'],
    configFiles: RUFF_CONFIG,
    writeMode: (args) => (hasAny(args, ['--fix', '--unsafe-fixes']) ? '--fix is set' : null),
    checkModeHint: 'ruff check .',
  },
  'ruff format': {
    tool: 'ruff format',
    fileList: 'replace-dot',
    extensions: ['py', 'pyi'],
    configFiles: RUFF_CONFIG,
    writeMode: lacksCheck(['--check', '--diff']),
    checkModeHint: 'ruff format --check .',
  },
  black: {
    tool: 'black',
    fileList: 'replace-dot',
    extensions: ['py', 'pyi'],
    configFiles: [/^pyproject\.toml$/],
    writeMode: lacksCheck(['--check', '--diff']),
    checkModeHint: 'black --check .',
  },
  flake8: {
    tool: 'flake8',
    fileList: 'replace-dot',
    extensions: ['py'],
    configFiles: [/^\.flake8$/, /^setup\.cfg$/, /^tox\.ini$/],
    writeMode: never,
    checkModeHint: 'flake8 .',
  },
  'dotnet format': {
    tool: 'dotnet format',
    fileList: 'include-flag',
    extensions: ['cs', 'vb'],
    configFiles: [/^\.editorconfig$/, /\.globalconfig$/, /^Directory\.Build\.props$/],
    writeMode: (args) => (args.includes('--verify-no-changes') ? null : 'no --verify-no-changes'),
    checkModeHint: 'dotnet format <solution> --verify-no-changes',
  },
  'golangci-lint': {
    tool: 'golangci-lint',
    fileList: 'none',
    extensions: ['go'],
    configFiles: [/^\.golangci\./, /^go\.mod$/],
    writeMode: flagIs('--fix'),
    checkModeHint: 'golangci-lint run',
  },
  'go vet': {
    tool: 'go vet',
    fileList: 'none',
    extensions: ['go'],
    configFiles: [/^go\.mod$/],
    writeMode: never,
    checkModeHint: 'go vet ./...',
  },
  'cargo clippy': {
    tool: 'cargo clippy',
    fileList: 'none',
    extensions: ['rs'],
    configFiles: [/^Cargo\.toml$/, /^\.?clippy\.toml$/],
    writeMode: flagIs('--fix'),
    checkModeHint: 'cargo clippy',
  },
  'cargo fmt': {
    tool: 'cargo fmt',
    fileList: 'none',
    extensions: ['rs'],
    configFiles: [/^\.?rustfmt\.toml$/],
    writeMode: lacksCheck(['--check']),
    checkModeHint: 'cargo fmt --check',
  },
  tsc: {
    tool: 'tsc',
    fileList: 'none',
    extensions: JS_EXTENSIONS,
    configFiles: [/^tsconfig.*\.json$/, /^package\.json$/],
    writeMode: never,
    checkModeHint: 'tsc --noEmit',
  },
  'npm run lint': {
    tool: 'npm run lint',
    fileList: 'none',
    extensions: 'non-doc',
    configFiles: [/^package\.json$/],
    writeMode: never,
    checkModeHint: 'npm run lint',
  },
};

const TWO_WORD_TOOLS = new Set(['ruff', 'dotnet', 'go', 'cargo']);

/** Index of the first token after any launcher prefix (`npx`, `pnpm exec`, `uv run`, `python -m`, ...). */
function skipLauncher(argv: readonly string[]): number {
  const [first, second] = argv;
  if (first === 'npx') {
    let i = 1;
    while (argv[i] !== undefined && /^(--no-install|--yes|-y|--)$/.test(argv[i]!)) i++;
    return i;
  }
  if (first === 'bunx' || first === 'yarn') return 1;
  if (first === 'pnpm' && second === 'exec') return 2;
  if ((first === 'uv' || first === 'poetry') && second === 'run') return 2;
  if ((first === 'python' || first === 'python3') && second === '-m') return 2;
  return 0;
}

/** The profile key and the index of the first argument after the tool name. */
function matchTool(argv: readonly string[]): { profile: LintToolProfile; argsFrom: number } | null {
  const start = skipLauncher(argv);
  const head = argv[start];
  if (head === undefined) return null;
  const key = TWO_WORD_TOOLS.has(head) && argv[start + 1] !== undefined ? `${head} ${argv[start + 1]}` : head;
  const profile = Object.hasOwn(LINT_TOOL_PROFILES, key) ? LINT_TOOL_PROFILES[key] : undefined;
  if (profile === undefined) return null;
  return { profile, argsFrom: start + (key === head ? 1 : 2) };
}

export function lintToolProfile(cmd: LintCommand): LintToolProfile | null {
  if (cmd.label === 'lint') return LINT_TOOL_PROFILES['npm run lint']!;
  if (cmd.label === 'tsc') return LINT_TOOL_PROFILES.tsc!;
  return matchTool(cmd.argv)?.profile ?? null;
}

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase();
}

function describeExtensions(profile: LintToolProfile): string {
  return profile.extensions === 'non-doc' ? 'only docs changed' : profile.extensions.map((e) => `.${e}`).join(', ');
}

/** Decide how to run one lint command given the changed paths (already filtered to those still on disk). */
export function scopeLintCommand(cmd: LintCommand, changed: readonly string[]): LintScope {
  const profile = lintToolProfile(cmd);
  if (profile === null) return { kind: 'whole', argv: cmd.argv, profile: null };
  const matched = cmd.label === 'checks.lint' ? matchTool(cmd.argv) : null;
  const args = matched === null ? cmd.argv.slice(1) : cmd.argv.slice(matched.argsFrom);

  const why = profile.writeMode(args);
  if (why !== null) {
    return {
      kind: 'write-mode',
      reason: `${cmd.label}: skipped — warning: runs ${profile.tool} in write mode (${why}); declare a check-mode command such as \`${profile.checkModeHint}\``,
    };
  }
  if (changed.some((p) => profile.configFiles.some((re) => re.test(basename(p))))) {
    return { kind: 'whole', argv: cmd.argv, profile };
  }
  const exts = profile.extensions;
  const matching = changed.filter((p) => {
    const ext = extensionOf(p);
    return exts === 'non-doc' ? !DOC_EXTENSIONS.includes(ext) : exts.includes(ext);
  });
  if (matching.length === 0) {
    return {
      kind: 'skip',
      reason: `${cmd.label}: skipped — no changed file matches ${profile.tool} file types (${describeExtensions(profile)})`,
    };
  }
  if (profile.fileList === 'none' || matching.length > MAX_AFFECTED_FILES) {
    return { kind: 'whole', argv: cmd.argv, profile };
  }
  const whole: LintScope = { kind: 'whole', argv: cmd.argv, profile };
  if (profile.fileList === 'include-flag') {
    if (args.includes('--include')) return whole;
    return { kind: 'files', argv: [...cmd.argv, '--include', ...matching], files: matching };
  }
  const operands = args.filter((a) => !a.startsWith('-'));
  if (!operands.every((a) => a === '.' || a === './')) return whole;
  const kept = cmd.argv.filter((a, i) => i < (matched?.argsFrom ?? 1) || a.startsWith('-'));
  return { kind: 'files', argv: [...kept, ...matching], files: matching };
}

const MAX_FINDINGS = 50;
const TSC_LINE = /^(.+?)\((\d+),\d+\):\s*(?:error|warning)\s+([\w.-]+)\s*:/;
const RUFF_LINE = /^(.+?):(\d+):\d+:\s+([A-Z]+\d+)\b/;
const GOLANGCI_LINE = /^(.+?):(\d+):\d+:\s+.*\(([\w:.-]+)\)\s*$/;
const ESLINT_FILE = /^\S.*\.\w+$/;
const ESLINT_ENTRY = /^\s+(\d+):\d+\s+(?:error|warning)\s+.*\s(\S+)\s*$/;

function normalizeFindingPath(path: string, worktree?: string): string {
  let p = path.trim().replaceAll('\\', '/');
  if (worktree !== undefined) {
    const prefix = `${worktree.replaceAll('\\', '/').replace(/\/+$/, '')}/`;
    if (p.startsWith(prefix)) p = p.slice(prefix.length);
  }
  return p.replace(/^\.\//, '');
}

/** `file:line rule` triples parsed from tool output, deduped, in first-seen order (at most 50). */
export function extractLintFindings(output: string, worktree?: string): LintFinding[] {
  const found = new Map<string, LintFinding>();
  let eslintFile: string | null = null;
  const add = (file: string, line: string, rule: string): void => {
    const f = normalizeFindingPath(file, worktree);
    found.set(`${f}:${line}:${rule}`, { file: f, line: Number(line), rule });
  };
  for (const text of output.split(/\r?\n/)) {
    const m = TSC_LINE.exec(text) ?? RUFF_LINE.exec(text) ?? GOLANGCI_LINE.exec(text);
    if (m) {
      add(m[1]!, m[2]!, m[3]!);
    } else if (ESLINT_FILE.test(text)) {
      eslintFile = text;
    } else if (eslintFile !== null) {
      const e = ESLINT_ENTRY.exec(text);
      if (e) add(eslintFile, e[1]!, e[2]!);
    }
    if (found.size >= MAX_FINDINGS) break;
  }
  return [...found.values()];
}

const MAX_RENDERED_FINDINGS = 10;

/** `file:line rule` joined by `; `, at most 10 with a `(+N more)` tail; '' when there are none. */
export function formatLintFindings(findings: readonly LintFinding[]): string {
  const shown = findings.slice(0, MAX_RENDERED_FINDINGS).map((f) => `${f.file}:${f.line} ${f.rule}`);
  const more = findings.length - shown.length;
  return more > 0 ? `${shown.join('; ')} (+${more} more)` : shown.join('; ');
}

const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/** Base ref, merge-base SHA and changed files that still exist, or why the diff is unavailable. */
export async function resolveLintDiff(
  ctx: Pick<CheckerContext, 'worktree' | 'diffBase' | 'parentBaseRef'>,
  run: DiffRunner = defaultDiffRunner,
): Promise<LintDiff | { unavailable: string }> {
  const candidates =
    ctx.parentBaseRef === undefined
      ? [...BASE_REF_CANDIDATES, ...(ctx.diffBase === undefined ? [] : [ctx.diffBase])]
      : [ctx.parentBaseRef];
  let baseRef: string | null = null;
  for (const candidate of candidates) {
    const r = await run(['git', 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], ctx.worktree);
    if (r.ok) {
      baseRef = candidate;
      break;
    }
  }
  if (baseRef === null) return { unavailable: 'no base ref resolves' };
  const mb = await run(['git', 'merge-base', baseRef, 'HEAD'], ctx.worktree);
  const mergeBase = mb.stdout.trim();
  if (!mb.ok || !SHA_PATTERN.test(mergeBase)) return { unavailable: `no merge base with ${baseRef}` };
  const listed = await listChangedFiles(ctx.worktree, baseRef, run);
  if (listed === null) return { unavailable: `cannot list files changed since ${baseRef}` };
  return { baseRef, mergeBase, changed: listed.filter((p) => existsSync(join(ctx.worktree, p))) };
}

export interface MergeBaseWorktreeOptions {
  laneWorktree: string;
  mergeBase: string;
  env?: Record<string, string>;
  run: (argv: readonly string[], options: RunCommandOptions) => Promise<CommandResult>;
}

/** Run `fn` in a temporary detached worktree at the merge base, after the frozen dependency install. Never throws. */
export async function withMergeBaseWorktree<T>(
  opts: MergeBaseWorktreeOptions,
  fn: (baseWorktree: string) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const { laneWorktree, mergeBase, env, run } = opts;
  try {
    return await withTempDir('factory-lint-base-', async (parent) => {
      const base = join(parent, 'base');
      const add = await run(['git', 'worktree', 'add', '--detach', base, mergeBase], {
        cwd: laneWorktree,
        timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      });
      if (add.exitCode !== 0) {
        return {
          ok: false as const,
          error: `git worktree add failed: ${(add.stderr || add.stdout).trim().slice(0, 300)}`,
        };
      }
      try {
        const install = dependencyInstallCommand(base);
        if (install !== null) {
          const r = await run(install, { cwd: base, env, timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS });
          if (r.exitCode !== 0) {
            return {
              ok: false as const,
              error: `base dependency install failed (${install.join(' ')}): ${(r.stderr || r.stdout).trim().slice(-300)}`,
            };
          }
        }
        return { ok: true as const, value: await fn(base) };
      } finally {
        await removeBaseWorktree(run, laneWorktree, base);
      }
    });
  } catch (e: unknown) {
    return { ok: false, error: `merge-base run failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` };
  }
}

/** Best-effort removal of our worktree; never throws. */
async function removeBaseWorktree(
  run: MergeBaseWorktreeOptions['run'],
  laneWorktree: string,
  base: string,
): Promise<void> {
  try {
    const r = await run(['git', 'worktree', 'remove', '--force', base], {
      cwd: laneWorktree,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) {
      await rm(base, { recursive: true, force: true });
      await run(['git', 'worktree', 'prune'], { cwd: laneWorktree, timeoutMs: GIT_COMMAND_TIMEOUT_MS });
    }
  } catch {
    // cleanup is best-effort
  }
}
