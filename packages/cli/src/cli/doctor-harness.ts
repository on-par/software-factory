// src/cli/doctor-harness.ts — per-harness setup table and `<cli> installed` rows for `factory doctor`.

import { openCodeVersion } from '@on-par/factory-core/internal';

import type { DoctorCheck } from './doctor.js';
import { PI_INSTALL } from './first-run.js';

export interface HarnessSetup {
  section: string;
  /** HARNESS_CATALOG id whose CLI probe decides whether this harness is installed (#2631). */
  harnessId: string;
  cli: string;
  install: string;
  /** Exact shell command that signs the harness in (#2556); also the row's `next` command. */
  login: string;
  /** Shell command for the sign-in row's `next` line when `login` is a prose hint (#2903); defaults to `login`. */
  next?: string;
  /** Env vars that count as sign-in evidence (#2556). */
  envKeys: readonly string[];
  /** Judges the first `--version` line for the installed row (#2880); harnesses without one just print it. */
  checkVersion?: (versionLine: string | undefined) => Pick<DoctorCheck, 'ok' | 'detail' | 'fix'>;
}

/** Warns, without failing, when the installed OpenCode is outside the supported range (#2880). */
export function openCodeVersionCheck(versionLine: string | undefined): Pick<DoctorCheck, 'ok' | 'detail' | 'fix'> {
  if (!versionLine) {
    return {
      ok: true,
      detail: `found on PATH (version unknown, supported ${openCodeVersion.OPENCODE_SUPPORTED_RANGE})`,
    };
  }
  const parsed = openCodeVersion.parseOpenCodeVersion(versionLine);
  if (!parsed) {
    return {
      ok: true,
      detail: `found on PATH (version unknown: ${versionLine}, supported ${openCodeVersion.OPENCODE_SUPPORTED_RANGE})`,
    };
  }
  if (openCodeVersion.isOpenCodeVersionSupported(parsed)) {
    return {
      ok: true,
      detail: `found on PATH (${versionLine}, supported ${openCodeVersion.OPENCODE_SUPPORTED_RANGE})`,
    };
  }
  return {
    ok: false,
    detail: `OpenCode ${versionLine} is outside the supported range ${openCodeVersion.OPENCODE_SUPPORTED_RANGE}; install the tested version: ${openCodeVersion.OPENCODE_PINNED_INSTALL}`,
    fix: `install the tested OpenCode: ${openCodeVersion.OPENCODE_PINNED_INSTALL}`,
  };
}

/** One doctor section per built-in harness (#2555), in display order. */
export const HARNESS_SETUP: readonly HarnessSetup[] = [
  {
    section: 'Claude Code',
    harnessId: 'claude-cli',
    cli: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude /login',
    envKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  },
  {
    section: 'Codex',
    harnessId: 'codex-cli',
    cli: 'codex',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    envKeys: ['CODEX_API_KEY'],
  },
  {
    section: 'OpenCode',
    harnessId: 'opencode',
    cli: 'opencode',
    install: openCodeVersion.OPENCODE_PINNED_INSTALL,
    login: 'opencode auth login',
    envKeys: ['OPENCODE_API_KEY'],
    checkVersion: openCodeVersionCheck,
  },
  {
    section: 'Pi',
    harnessId: 'pi',
    cli: 'pi',
    install: PI_INSTALL,
    login: 'run `pi` then `/login <provider>`, or export the provider key',
    next: 'pi',
    envKeys: ['OPENROUTER_API_KEY', 'OPENCODE_API_KEY', 'AZURE_OPENAI_API_KEY'],
  },
];

/** Detail of a `<cli> installed` row when the CLI is not on PATH; doctor matches it exactly to skip the row (#2996). */
export function notInstalledDetail(cli: string): string {
  return `${cli} not found on PATH, ${cli} routes unavailable`;
}

const INSTALL_ROW_CLI = new Map(HARNESS_SETUP.map(({ cli }) => [`${cli} installed`, cli]));

/** #2996: rewrites a not-installed agent row (`<cli> installed` with the exact not-on-PATH detail, or a failing
 *  `codex sandbox`) to ➖ skipped info; every other row is returned as is. Call only while an agent is signed in. */
export function skipMissingAgentCheck(c: DoctorCheck): DoctorCheck {
  if (c.ok) return c;
  const cli = INSTALL_ROW_CLI.get(c.name);
  const missing = cli !== undefined ? c.detail === notInstalledDetail(cli) : c.name === 'codex sandbox';
  if (!missing) return c;
  const { fix: _fix, ...rest } = c;
  return {
    ...rest,
    ok: true,
    optional: true,
    detail: `skipped: ${cli ?? 'codex'} not installed; another agent is signed in, so runs can proceed`,
  };
}

/** One optional `<cli> installed` row per harness, with the CLI version when found and the install command when not (#2555). */
export function harnessInstallChecks(
  commandAvailable: (cmd: string) => boolean,
  tryExec: (cmd: string) => string | null,
): DoctorCheck[] {
  return HARNESS_SETUP.map(({ section, cli, install, checkVersion }): DoctorCheck => {
    const name = `${cli} installed`;
    if (!commandAvailable(cli)) {
      return {
        name,
        section,
        ok: false,
        optional: true,
        detail: notInstalledDetail(cli),
        fix: `install ${section}: ${install}`,
      };
    }
    const version = tryExec(`${cli} --version`)?.trim().split('\n')[0]?.trim();
    if (checkVersion) {
      const { fix, ...verdict } = checkVersion(version || undefined);
      return { name, section, optional: true, ...verdict, ...(fix === undefined ? {} : { fix }) };
    }
    return {
      name,
      section,
      ok: true,
      optional: true,
      detail: version ? `found on PATH (${version})` : 'found on PATH (version unknown)',
    };
  });
}
