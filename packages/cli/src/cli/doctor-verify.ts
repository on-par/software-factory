// packages/cli/src/cli/doctor-verify.ts — `factory doctor` Verify section: the build/test/lint commands CHECK will run (#3473)

import { basename } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import {
  describeChecksProbe,
  resolveCompileCommand,
  resolveLintCommands,
  resolveTestsCommand,
} from '@on-par/factory-core/internal';

import { MIN_NODE_MAJOR } from '../node-version.js';
import type { DoctorCheck } from './doctor.js';

export const VERIFY_SECTION = 'Verify';

export type VerifyKind = 'build' | 'test' | 'lint';

export interface VerifyCommandRow {
  kind: VerifyKind;
  /** The command CHECK runs, space-joined argv; null when none resolves. */
  command: string | null;
  /** Where it came from: the repo config file (`checks`), scripts/verify.sh, scripts/verify.ps1, package.json, pytest, Makefile, Cargo.toml, tsconfig.json; null when none. */
  source: string | null;
  /** argv[0]; null when there is no command. */
  executable: string | null;
  /** Filled by withPathResults for --json; null when there is no command. */
  onPath?: boolean | null;
}

export interface ResolvedVerifyCommands {
  rows: VerifyCommandRow[];
  error?: string;
  /** The config file probed for `checks`, named in the missing-command rows (#3600). */
  checksProbe?: string;
  /** The repo config file name shown in fix hints, e.g. `.factory/config.yaml` (#3604). */
  configFile?: string;
}

const TEST_SOURCES = {
  verify: 'scripts/verify.sh',
  'verify-ps1': 'scripts/verify.ps1',
  npm: 'package.json',
  pytest: 'pytest',
} as const;

const LINT_SOURCES = { lint: 'package.json', tsc: 'tsconfig.json' } as const;

function rowFor(kind: VerifyKind, argv: string[], source: string): VerifyCommandRow {
  return { kind, command: argv.join(' '), source, executable: argv[0] ?? null };
}

const emptyRow = (kind: VerifyKind): VerifyCommandRow => ({ kind, command: null, source: null, executable: null });

/** Asks the CHECK resolvers what CHECK will run, so doctor cannot drift from CHECK. A resolver
 *  failure (for example a malformed package.json) comes back as `error`, never a throw. */
export async function resolveVerifyCommands(repoRoot: string): Promise<ResolvedVerifyCommands> {
  const src = { worktree: repoRoot };
  const checksProbe = describeChecksProbe(src, 'source checkout');
  const configFile = `.factory/${basename(getFactoryPaths(repoRoot).config)}`;
  try {
    const build = await resolveCompileCommand(src);
    const tests = await resolveTestsCommand(src);
    const lint = await resolveLintCommands(src);
    return {
      rows: [
        build ? rowFor('build', build.argv, build.source) : emptyRow('build'),
        tests.runner === 'none'
          ? emptyRow('test')
          : rowFor('test', tests.argv, tests.runner === 'config' ? tests.source! : TEST_SOURCES[tests.runner]),
        ...(lint.length > 0
          ? lint.map((c) => rowFor('lint', c.argv, c.label === 'checks.lint' ? c.source! : LINT_SOURCES[c.label]))
          : [emptyRow('lint')]),
      ],
      checksProbe,
      configFile,
    };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err), checksProbe, configFile };
  }
}

/** Rows with `onPath` filled from the host's PATH, for `factory doctor --json`. */
export function withPathResults(
  rows: VerifyCommandRow[],
  commandAvailable: (cmd: string) => boolean,
): VerifyCommandRow[] {
  return rows.map((r) => ({ ...r, onPath: r.executable === null ? null : commandAvailable(r.executable) }));
}

const noTestsFix = (configFile: string) =>
  `run \`factory init --detect-checks\` to find and declare your test command under \`checks\` in ${configFile} (or add scripts/verify.sh, scripts/verify.ps1, or a package.json "test" script)`;
const DEFAULT_CONFIG_FILE = '.factory/config.yaml|yml|json';
const DEFAULT_CHECKS_PROBE = DEFAULT_CONFIG_FILE;

function missingRow(
  row: VerifyCommandRow,
  requireTests: boolean,
  probe = DEFAULT_CHECKS_PROBE,
  configFile = DEFAULT_CONFIG_FILE,
): DoctorCheck {
  const section = VERIFY_SECTION;
  const noTestsDetail = `no checks.test in ${probe}, scripts/verify.sh, scripts/verify.ps1, package.json test script or pytest surface`;
  if (row.kind === 'test') {
    return requireTests
      ? {
          name: 'verify test',
          section,
          ok: false,
          detail: `CHECK will run no tests, but the constitution sets requireTests: true; ${noTestsDetail}`,
          fix: noTestsFix(configFile),
        }
      : {
          name: 'verify test',
          section,
          ok: false,
          optional: true,
          detail: `CHECK will run no tests; ${noTestsDetail}`,
          fix: noTestsFix(configFile),
        };
  }
  if (row.kind === 'build') {
    return {
      name: 'verify build',
      section,
      ok: false,
      optional: true,
      detail: `no build system detected (checks.build in ${probe}, package.json build script, Makefile, Cargo.toml); CHECK skips compile`,
      fix: 'run `factory init --detect-checks` to declare a build command',
    };
  }
  return {
    name: 'verify lint',
    section,
    ok: true,
    optional: true,
    detail: `no lint command (checks.lint in ${probe}, package.json lint script, tsconfig.json); CHECK skips lint`,
  };
}

/** Verify-section rows for the resolved CHECK commands: a missing executable always fails; no test
 *  command warns, and fails when the constitution sets requireTests. Pure. */
export function verifyCommandChecks(
  resolved: ResolvedVerifyCommands,
  opts: { requireTests: boolean; commandAvailable: (cmd: string) => boolean },
): DoctorCheck[] {
  const section = VERIFY_SECTION;
  if (resolved.error !== undefined) {
    return [
      {
        name: 'verify commands',
        section,
        ok: false,
        detail: `cannot resolve CHECK commands: ${resolved.error}`,
        fix: `fix package.json and ${resolved.configFile ?? DEFAULT_CONFIG_FILE} so they parse`,
      },
    ];
  }
  return resolved.rows.map((row): DoctorCheck => {
    const { command, source, executable } = row;
    if (command === null || executable === null)
      return missingRow(row, opts.requireTests, resolved.checksProbe, resolved.configFile);
    const name = row.kind === 'lint' ? `verify lint (${source})` : `verify ${row.kind}`;
    if (opts.commandAvailable(executable)) {
      return { name, section, ok: true, detail: `\`${command}\` (from ${source}); ${executable} found on PATH` };
    }
    return {
      name,
      section,
      ok: false,
      detail: `\`${command}\` (from ${source}); ${executable} not found on PATH`,
      fix: `install ${executable} and put it on PATH${executable === 'pwsh' ? ': https://aka.ms/powershell' : ''}`,
    };
  });
}

/** The npm row: required unless doctor runs in a repo with no package.json (`hasPackageJson` false). */
export function npmCheck(available: boolean, hasPackageJson: boolean): DoctorCheck {
  if (available) return { name: 'npm', ok: true, detail: 'found on PATH' };
  const fix = `install Node.js >= ${MIN_NODE_MAJOR} (which ships npm): https://nodejs.org`;
  return hasPackageJson
    ? { name: 'npm', ok: false, detail: 'not found on PATH', fix }
    : {
        name: 'npm',
        ok: false,
        optional: true,
        detail: 'not found on PATH (not needed: this repo has no package.json)',
        fix,
      };
}
