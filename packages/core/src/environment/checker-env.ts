// src/environment/checker-env.ts — the parent-env allow-list checker commands start from (#1590)

/** Operator escape hatch: comma-separated extra exact variable names checker commands may inherit. */
export const CHECKER_ENV_ALLOW_VAR = 'FACTORY_CHECKER_ENV_ALLOW';

/**
 * Parent variables a checker command may inherit. Single owner of the list; the sandbox slice reuses it.
 * Exact names, except an entry ending in `*` is a prefix. Matching is case-insensitive.
 */
export const CHECKER_ENV_ALLOWLIST: readonly string[] = [
  // POSIX basics
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_*',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  // XDG
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  // Node and npm
  'NODE_OPTIONS',
  'npm_config_*',
  'COREPACK_HOME',
  'PNPM_HOME',
  'NVM_DIR',
  // Proxies
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  // Lane contract
  'PORT',
  'FACTORY_APP_PORT',
  'FACTORY_BASE_URL',
  'FACTORY_HEADLESS',
  'PLAYWRIGHT_HEADLESS',
  'PLAYWRIGHT_BROWSERS_PATH',
  // dotnetEnv keys
  'DOTNET_TieredPGO',
  'MSBUILDDISABLENODEREUSE',
  'SharedCompilationId',
  'DiffEngine_Disabled',
  'DOTNET_CLI_TELEMETRY_OPTOUT',
  'DOTNET_NOLOGO',
  'DOTNET_ROOT',
  'NUGET_PACKAGES',
  // hermeticGitEnv keys
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  // Factory supervision (read by the detached runner)
  'FACTORY_DAEMON_GROUPS_FILE',
  // Toolchains
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'GOCACHE',
  'GOMODCACHE',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'VIRTUAL_ENV',
  'PYENV_ROOT',
  // Windows
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

const CREDENTIAL_NAME = /(?:TOKEN|SECRET|PASSWORD|_AUTH|API_?KEY|CREDENTIAL|PRIVATE_KEY)/i;

const EXACT = new Set(CHECKER_ENV_ALLOWLIST.filter((e) => !e.endsWith('*')).map((e) => e.toUpperCase()));
const PREFIXES = CHECKER_ENV_ALLOWLIST.filter((e) => e.endsWith('*')).map((e) => e.slice(0, -1).toUpperCase());

/** True when `name` may be inherited: an exact entry (or `extra`), or a prefix entry that is not credential-shaped. */
export function isCheckerEnvAllowed(name: string, extra: readonly string[] = []): boolean {
  const upper = name.toUpperCase();
  if (EXACT.has(upper) || extra.some((e) => e.toUpperCase() === upper)) return true;
  return PREFIXES.some((p) => upper.startsWith(p)) && !CREDENTIAL_NAME.test(name);
}

/** The allow-listed subset of `parent`, honoring `FACTORY_CHECKER_ENV_ALLOW` in `parent`. */
export function checkerParentEnv(parent: Record<string, string | undefined> = process.env): Record<string, string> {
  const extra = (parent[CHECKER_ENV_ALLOW_VAR] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && isCheckerEnvAllowed(name, extra)) out[name] = value;
  }
  return out;
}
