import type { TestsAffectedConfig } from '../config/tests-section.js';
import { globToRegExp } from '../review/floor.js';
import type { Constitution } from '../types/index.js';
import { defaultDiffRunner, type DiffRunner } from './design-smells.js';
import { tokenizeEvidenceCommand } from './evidence-allowlist.js';

export const MAX_AFFECTED_FILES = 200;

export const AFFECTED_TESTS_BUILTIN_TRIGGERS: readonly string[] = [
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/pnpm-lock.yaml',
  '**/pnpm-workspace.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb',
  '**/pyproject.toml',
  '**/poetry.lock',
  '**/uv.lock',
  '**/requirements*.txt',
  '**/Pipfile',
  '**/Pipfile.lock',
  '**/Cargo.toml',
  '**/Cargo.lock',
  '**/go.mod',
  '**/go.sum',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/vite.config.*',
  '**/jest.config.*',
  '**/pytest.ini',
  '**/conftest.py',
  '**/setup.cfg',
  '**/nx.json',
  '**/project.json',
  '**/tsconfig*.json',
  '.github/workflows/**',
  'scripts/verify.sh',
  '.factory/config.json',
  '**/migrations/**',
];

export type AffectedFullReason =
  'not-configured' | 'no-diff-base' | 'no-changed-files' | 'too-many-files' | 'trigger' | 'zero-tests' | 'tool-error';

export type AffectedTestsResolution =
  | {
      kind: 'affected';
      command: string;
      argv: string[];
      fileCount: number;
      typecheck?: { argv: string[]; command: string };
    }
  | { kind: 'full'; reason: AffectedFullReason; trigger?: string; fileCount: number };

export function shellQuotePath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

export function resolveAffectedTestsCommand(input: {
  repo: { tests?: { affected?: TestsAffectedConfig } } | null | undefined;
  constitution: Pick<Constitution, 'affectedTestsFullOn'> | null | undefined;
  changedFiles: readonly string[];
}): AffectedTestsResolution {
  const cfg = input.repo?.tests?.affected;
  const files = [...new Set(input.changedFiles.map(normalizePath).filter((p) => p !== ''))];
  const fileCount = files.length;
  if (!cfg) return { kind: 'full', reason: 'not-configured', fileCount };
  if (fileCount === 0) return { kind: 'full', reason: 'no-changed-files', fileCount };
  if (fileCount > MAX_AFFECTED_FILES) return { kind: 'full', reason: 'too-many-files', fileCount };

  const triggers = [
    ...AFFECTED_TESTS_BUILTIN_TRIGGERS,
    ...(cfg.fullOn ?? []),
    ...(input.constitution?.affectedTestsFullOn ?? []),
  ].map(globToRegExp);
  const trigger = files.find((f) => triggers.some((re) => re.test(f)));
  if (trigger !== undefined) return { kind: 'full', reason: 'trigger', trigger, fileCount };

  const tokens = tokenizeEvidenceCommand(cfg.command);
  if (!tokens?.includes('{files}')) return { kind: 'full', reason: 'not-configured', fileCount };
  const expand = (parts: readonly string[]): { argv: string[]; command: string } => ({
    argv: parts.flatMap((t) => (t === '{files}' ? files : [t])),
    command: parts.map((t) => (t === '{files}' ? files.map(shellQuotePath).join(' ') : t)).join(' '),
  });
  const typecheckTokens = cfg.typecheck === undefined ? null : tokenizeEvidenceCommand(cfg.typecheck);
  return {
    kind: 'affected',
    ...expand(tokens),
    fileCount,
    ...(typecheckTokens ? { typecheck: expand(typecheckTokens) } : {}),
  };
}

export async function listChangedFiles(
  worktree: string,
  diffBase: string,
  run: DiffRunner = defaultDiffRunner,
): Promise<string[] | null> {
  const committed = await run(['git', 'diff', '--name-only', `${diffBase}...HEAD`], worktree);
  if (!committed.ok) return null;
  const rest = await Promise.all([
    run(['git', 'diff', '--name-only', 'HEAD'], worktree),
    run(['git', 'ls-files', '--others', '--exclude-standard'], worktree),
  ]);
  const paths = new Set<string>();
  for (const r of [committed, ...rest.filter((x) => x.ok)]) {
    for (const line of r.stdout.split('\n')) {
      if (line.trim() !== '') paths.add(line.trim());
    }
  }
  return [...paths].sort();
}

export function describeAffectedResolution(r: AffectedTestsResolution, round: number): string {
  const head = `affected tests (round ${round}):`;
  if (r.kind === 'affected') {
    const typecheck = r.typecheck ? `; typecheck — ${r.typecheck.command}` : '';
    return `${head} affected — ${r.command} (${r.fileCount} files)${typecheck}`;
  }
  return `${head} full — ${r.reason}${r.trigger === undefined ? '' : ` (${r.trigger})`} (${r.fileCount} files)`;
}
