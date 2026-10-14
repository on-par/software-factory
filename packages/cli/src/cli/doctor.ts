// packages/cli/src/cli/doctor.ts — `factory doctor` environment preflight

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Octokit } from '@octokit/rest';
import type { DeclaredHarnessProbe, EventKind, FactoryConfig, LeaseHealth } from '@on-par/factory-core';
import {
  applyRepoConfig,
  ConstitutionLoader,
  detectSandboxRuntime,
  getFactoryPaths,
  inspectPortLeases,
  KNOWN_HARNESS_IDS,
  loadFactoryConfig,
  reapStalePortLeases,
  resolveProcessGroupGraceMs,
  resolveSandboxPolicy,
} from '@on-par/factory-core';
import type { ConfigLintInput, WorktreeSandbox } from '@on-par/factory-core/internal';
import {
  claudeStoredSessionState,
  codexChatgptSessionState,
  createOctokitQueueClient,
  hasClaudeLoginEvidence,
  hasOpencodeLoginEvidence,
  isHarnessCliPresent,
  localAuthFailureSinceLogin,
  logEvent,
  microVmName,
  resolveBranchPrefix,
  shellEscape,
  withFileLock,
  withGitLock,
  wrapCommandInSandbox,
} from '@on-par/factory-core/internal';

import { MIN_NODE_MAJOR } from '../node-version.js';
import { configLintChecks, declaredHarnessChecks, modelsRegistryChecks } from './doctor-config.js';
import {
  analyzeEventLog,
  eventLogCheck,
  formatClaimReconcileReport,
  formatContainerReconcileReport,
  formatMicroVmReconcileReport,
  formatReconcileReport,
  formatWorktreeReconcileReport,
  type GreenPrScanResult,
  leaseChecks,
  type LeaseHealthRow,
  orphanContainerChecks,
  orphanMicroVmChecks,
  unmergedGreenPrChecks,
} from './doctor-health.js';
import { availableAgentClis, CLAUDE_CODE_URL, CODEX_CLI_URL, GITHUB_TOKENS_URL } from './first-run.js';
import type { CliDeps } from './index.js';
import { distFreshnessProbe } from './staleness.js';
import { readStopFileStatus, stopSentinelCheck } from './stop-sentinel.js';
import { checkSweepHeartbeat, defaultSweepHeartbeatDeps, sweepHeartbeatCheck } from './sweep-heartbeat.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** One-line fix suggestion; only meaningful when ok=false. */
  fix?: string;
  /** Optional checks never fail the doctor exit code. */
  optional?: boolean;
  /** Setup section the row renders under (#2555); unsectioned rows render first. */
  section?: string;
  /** Exactly one shell command to run next (#2557); rendered as the last line of a non-ok row. */
  next?: string;
}

export interface DoctorExecOptions {
  /** Extra env vars merged over process.env for this command. */
  env?: Record<string, string>;
  /** Kill the command after this many ms; the probe then returns null. */
  timeoutMs?: number;
}

/** A declared, agentic command harness the repo's models.registry uses (#2691). */
export interface ConfiguredCommandHarness {
  harness: string;
  /** The declared `command` template, verbatim. */
  command: string;
  /** First token of `command` to look up on PATH; null when it cannot be parsed safely. */
  executable: string | null;
}

export interface DoctorEnvProbes {
  commandAvailable: (cmd: string) => boolean;
  envPresent: (key: string) => boolean;
  /** Run a command, return trimmed stdout, or null if it fails. `opts` adds env vars and a timeout. */
  tryExec: (cmd: string, opts?: DoctorExecOptions) => string | null;
  pathExists: (p: string) => boolean;
  /** Host platform; defaults to process.platform. */
  platform?: NodeJS.Platform;
  distFreshness?: () => { fresh: boolean; detail: string };
  /** Stored Codex ChatGPT session state (#2509), read locally; never refreshes. */
  codexSessionState?: () => 'ok' | 'refresh-pending' | 'unusable' | 'unknown';
  /** Whether a stored Claude Code login exists (#2556); reads local state only, never runs inference. */
  claudeLoggedIn?: () => boolean;
  /** Stored Claude Code OAuth session state (#2721), read locally; never refreshes. */
  claudeSessionState?: () => 'ok' | 'refresh-pending' | 'unusable' | 'unknown';
  /** The agent's last recorded run-time local_auth failure when no login has happened since
   *  (#2733); reads local state only, never refreshes. */
  localAuthFailure?: (agent: 'claude' | 'codex') => { agent: string; at: string } | null;
  /** Whether a stored opencode auth login exists (#2556); reads local state only, never runs inference. */
  opencodeLoggedIn?: () => boolean;
  /** Repo-configured command harnesses (#2691); absent or [] means none. */
  commandHarnesses?: () => ConfiguredCommandHarness[];
}

/** Section for rows about repo-configured command harnesses (#2691). */
export const COMMAND_HARNESS_SECTION = 'Command harness';

/** Repo wired-up rows, sectioned only inside a git repo (#2557). */
export const REPO_SECTION = 'Repo';

export const NOT_IN_REPO_HINT = 'cd into your repo, then run factory doctor again';

/** Detail for every repo wired-up row when doctor runs outside a git repository (#2554). */
export const NOT_IN_REPO_SKIP_DETAIL = `skipped: not inside a git repository; ${NOT_IN_REPO_HINT}`;

export function hasSandboxRuntime(platform: NodeJS.Platform, commandAvailable: (cmd: string) => boolean): boolean {
  return detectSandboxRuntime(platform, commandAvailable) !== 'none';
}

/** Reason the sandboxed claude auth probe is skipped before a sandbox policy is resolved,
 *  or null when cmdDoctor should resolve the policy as before (#2383). */
export function sandboxAuthSkipDetail(opts: {
  runtimeAvailable: boolean;
  hostOk: boolean;
  inRepo: boolean;
}): string | null {
  if (!opts.runtimeAvailable) return 'skipped: no sandbox runtime (sandbox-exec/firejail) on this host';
  if (!opts.hostOk) return 'skipped: host claude auth was not verified';
  if (!opts.inRepo) return NOT_IN_REPO_SKIP_DETAIL;
  return null;
}

/** Sign-in method reported by `codex login status`, or null when it shows no login. Never returns
 *  any part of a credential: only a fixed label is derived from the status text. */
export function codexAuthMethod(statusOutput: string | null): string | null {
  if (statusOutput === null) return null;
  const text = statusOutput.toLowerCase();
  if (!text.includes('logged in') || text.includes('not logged in')) return null;
  if (text.includes('chatgpt')) return 'ChatGPT';
  if (text.includes('api key')) return 'API key';
  if (text.includes('access token')) return 'access token';
  return 'unknown method';
}

const GIT_AUTH_CHECK = 'git auth';

/** Non-interactive read-only probe of origin. `credential.interactive=never` turns off Git
 *  Credential Manager UI and an empty `core.askPass` turns off configured askpass programs;
 *  stored credentials from any helper still work. */
export const GIT_AUTH_PROBE_CMD = 'git -c credential.interactive=never -c core.askPass= ls-remote --quiet origin HEAD';
/** GIT_TERMINAL_PROMPT=0 makes git fail instead of asking on the terminal; empty GIT_ASKPASS
 *  and SSH_ASKPASS turn off askpass programs and ssh's GUI askpass; GCM_INTERACTIVE=never
 *  turns off Git Credential Manager prompts. */
export const GIT_AUTH_PROBE_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
};
/** Bounds the probe, e.g. an ssh key passphrase prompt that waits on /dev/tty. */
export const GIT_AUTH_PROBE_TIMEOUT_MS = 15_000;

/** Remedy shown only when the git-auth probe fails: wires git's credential helper to gh. */
export const GIT_AUTH_FIX = 'run `gh auth setup-git` so git uses your gh credentials, then re-run `factory doctor`';

/** Git-auth check (#2482, #2483): skipped, never failing, outside a git repository or without
 *  an origin remote. Otherwise runs a non-interactive `git ls-remote` against origin and fails
 *  when it cannot authenticate. The detail never echoes the origin URL, which may hold a token. */
export function gitAuthCheck(
  repoRoot: string | null,
  tryExec: (cmd: string, opts?: DoctorExecOptions) => string | null,
): DoctorCheck {
  if (repoRoot === null) {
    return {
      name: GIT_AUTH_CHECK,
      ok: true,
      optional: true,
      detail: NOT_IN_REPO_SKIP_DETAIL,
    };
  }
  const origin = tryExec('git remote get-url origin');
  if (!origin) {
    return { name: GIT_AUTH_CHECK, ok: true, optional: true, detail: 'skipped: no origin remote configured' };
  }
  // An empty string is exit 0 with no HEAD ref (an empty repo): still authenticated.
  const probe = tryExec(GIT_AUTH_PROBE_CMD, { env: { ...GIT_AUTH_PROBE_ENV }, timeoutMs: GIT_AUTH_PROBE_TIMEOUT_MS });
  if (probe === null) {
    return {
      name: GIT_AUTH_CHECK,
      ok: false,
      detail: 'git could not authenticate to origin non-interactively (prompting disabled)',
      fix: GIT_AUTH_FIX,
      next: 'gh auth setup-git',
    };
  }
  return { name: GIT_AUTH_CHECK, ok: true, detail: 'git can authenticate to origin non-interactively' };
}

export interface HarnessSetup {
  section: string;
  /** HARNESS_CATALOG id whose CLI probe decides whether this harness is installed (#2631). */
  harnessId: string;
  cli: string;
  install: string;
  /** Exact shell command that signs the harness in (#2556); also the row's `next` command. */
  login: string;
  /** Env vars that count as sign-in evidence (#2556). */
  envKeys: readonly string[];
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
    install: 'npm install -g opencode-ai',
    login: 'opencode auth login',
    envKeys: ['OPENCODE_API_KEY'],
  },
];

/** One optional `<cli> installed` row per harness, with the CLI version when found and the install command when not (#2555). */
export function harnessInstallChecks(
  commandAvailable: (cmd: string) => boolean,
  tryExec: (cmd: string) => string | null,
): DoctorCheck[] {
  return HARNESS_SETUP.map(({ section, cli, install }): DoctorCheck => {
    const name = `${cli} installed`;
    if (!commandAvailable(cli)) {
      return {
        name,
        section,
        ok: false,
        optional: true,
        detail: `${cli} not found on PATH, ${cli} routes unavailable`,
        fix: `install ${section}: ${install}`,
      };
    }
    const version = tryExec(`${cli} --version`)?.trim().split('\n')[0]?.trim();
    return {
      name,
      section,
      ok: true,
      optional: true,
      detail: version ? `found on PATH (${version})` : 'found on PATH (version unknown)',
    };
  });
}

const SIGN_IN_EVIDENCE: Readonly<Record<string, string>> = {
  claude: 'no ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or stored login',
  codex:
    'no CODEX_API_KEY or codex login; API billing: codex login --with-api-key; headless: codex login --device-auth',
  opencode: 'no OPENCODE_API_KEY or stored auth login',
};

function safe(fn: (() => boolean) | undefined): boolean {
  if (!fn) return false;
  try {
    return fn();
  } catch {
    return false;
  }
}

function safeState(fn: (() => string) | undefined): string {
  if (!fn) return 'unknown';
  try {
    return fn();
  } catch {
    return 'unknown';
  }
}

/** One `<cli> signed in` row per installed harness CLI (#2556, #2631), judged only from local evidence: an env key,
 *  stored credentials, or `codex login status`. Never runs inference and never prints a secret. */
export function harnessSignInChecks(probes: DoctorEnvProbes): DoctorCheck[] {
  const { commandAvailable, envPresent, tryExec } = probes;
  const found = availableAgentClis(commandAvailable);
  return HARNESS_SETUP.filter(({ harnessId }) => isHarnessCliPresent(harnessId, commandAvailable)).map(
    ({ section, cli, login, envKeys }): DoctorCheck => {
      const name = `${cli} signed in`;
      const fix = `sign in to ${section}: ${login}`;
      if (cli === 'claude' || cli === 'codex') {
        let failure: { agent: string; at: string } | null = null;
        try {
          failure = probes.localAuthFailure?.(cli) ?? null;
        } catch {
          failure = null;
        }
        if (failure) {
          return {
            name,
            section,
            ok: false,
            optional: found.length > 1,
            detail: `the most recent run failed sign-in (local_auth) at ${failure.at} and there has been no login since; re-run ${cli} login`,
            fix,
            next: login,
          };
        }
      }
      if (cli === 'codex') {
        const key = envKeys.find((k) => envPresent(k));
        if (key) return { name, section, ok: true, detail: `signed in (${key} set)` };
        const method = codexAuthMethod(tryExec('codex login status 2>&1'));
        const session = method === 'ChatGPT' ? (probes.codexSessionState?.() ?? 'unknown') : 'unknown';
        if (session === 'unusable') {
          return {
            name,
            section,
            ok: false,
            optional: found.length > 1,
            detail:
              'ChatGPT session in auth.json is unusable (unreadable, or no valid access token and no refresh token)',
            fix,
            next: login,
          };
        }
        if (session === 'refresh-pending') {
          return {
            name,
            section,
            ok: true,
            detail:
              'logged in with ChatGPT; access token expired, codex refreshes it on the next run (run `codex login` if that run fails with 401)',
          };
        }
        if (method) {
          return {
            name,
            section,
            ok: true,
            detail:
              method === 'ChatGPT'
                ? 'logged in with ChatGPT; runs draw on your ChatGPT plan limits (manage usage in ChatGPT settings)'
                : `logged in with ${method}`,
          };
        }
      } else {
        const key = envKeys.find((k) => envPresent(k));
        if (key) return { name, section, ok: true, detail: `signed in (${key} set)` };
        if (cli === 'claude' && safeState(probes.claudeSessionState) === 'unusable') {
          return {
            name,
            section,
            ok: false,
            optional: found.length > 1,
            detail:
              'stored Claude Code login has expired and cannot be refreshed (no live access token and no refresh token); re-run claude login',
            fix: 'run `claude`, then /login, then re-run `factory doctor`',
            next: login,
          };
        }
        if (cli === 'claude' && safe(probes.claudeLoggedIn)) {
          return { name, section, ok: true, detail: 'signed in (stored Claude Code login found)' };
        }
        if (cli === 'opencode' && safe(probes.opencodeLoggedIn)) {
          return { name, section, ok: true, detail: 'signed in (stored opencode auth login found)' };
        }
      }
      return {
        name,
        section,
        ok: false,
        // Required only when this is the sole agent: then nothing else can run.
        optional: found.length > 1,
        detail: `unverified: no sign-in evidence (${SIGN_IN_EVIDENCE[cli]})`,
        fix,
        next: login,
      };
    },
  );
}

function safeList(fn: (() => ConfiguredCommandHarness[]) | undefined): ConfiguredCommandHarness[] {
  if (!fn) return [];
  try {
    return fn();
  } catch {
    return [];
  }
}

/** The executable (first token) of a command template, or null when it cannot be parsed safely (#2691).
 *  Guards `isCommandAvailable`, which interpolates into `command -v` unescaped. */
export function commandExecutable(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
  let token = tokens[0];
  if (!token) return null;
  const quoted = /^(['"])(.*)\1$/.exec(token);
  if (quoted) token = quoted[2]!;
  return /^[\w./@+~-]+$/.test(token) ? token : null;
}

/** Declared, agentic command harnesses that at least one repo `models.registry` entry uses (#2691). */
export function repoCommandHarnesses(
  harnesses: Readonly<Record<string, { command: string; agentic: boolean }>> | undefined,
  registry: Readonly<Record<string, { harness?: string }>> | undefined,
): ConfiguredCommandHarness[] {
  const used = new Set(Object.values(registry ?? {}).map((def) => def.harness));
  return Object.entries(harnesses ?? {})
    .filter(([id, decl]) => decl.agentic && used.has(id))
    .map(([id, decl]) => ({ harness: id, command: decl.command, executable: commandExecutable(decl.command) }));
}

/** One optional `command harness <id>` row per configured command harness (#2691). */
export function commandHarnessChecks(
  harnesses: readonly ConfiguredCommandHarness[],
  commandAvailable: (cmd: string) => boolean,
): DoctorCheck[] {
  return harnesses.map((h): DoctorCheck => {
    const name = `command harness ${h.harness}`;
    if (h.executable !== null && commandAvailable(h.executable)) {
      return {
        name,
        section: COMMAND_HARNESS_SECTION,
        optional: true,
        ok: true,
        detail: `${h.executable} found on PATH (command: ${h.command})`,
      };
    }
    return {
      name,
      section: COMMAND_HARNESS_SECTION,
      optional: true,
      ok: false,
      detail: `configured command \`${h.command}\`: ${
        h.executable === null ? 'cannot parse an executable from it' : `${h.executable} not found on PATH`
      }`,
      fix: installFix(h),
    };
  });
}

function installFix(h: ConfiguredCommandHarness): string {
  return `install ${h.executable ?? 'the agent CLI'} on PATH or fix "command" for harness ${h.harness} in the models config harnesses section`;
}

/** Coding agent prerequisites: at least one agent CLI is required; each CLI is then reported
 *  on its own optional line, with sign-in reported separately from installation (#1269, #2422, #2555, #2556).
 *  A repo-configured command harness whose executable is on PATH also counts as a coding agent (#2691). */
export function agentCliChecks(probes: DoctorEnvProbes): DoctorCheck[] {
  const { commandAvailable, tryExec } = probes;
  const found = availableAgentClis(commandAvailable);
  const configured = safeList(probes.commandHarnesses);
  const runnable = configured.filter((h) => h.executable !== null && commandAvailable(h.executable));
  const agents = [...found, ...runnable.map((h) => `${h.harness} (command harness)`)];
  const describe = (h: ConfiguredCommandHarness): string =>
    `command harness ${h.harness} runs \`${h.command}\`, but ${h.executable ?? 'its executable'} is not on PATH`;
  const missingRow: DoctorCheck =
    configured.length === 0
      ? {
          name: 'coding agent',
          ok: false,
          detail: 'no coding agent CLI on PATH (claude, codex or opencode)',
          fix: `install Claude Code (${CLAUDE_CODE_URL}) or the Codex CLI (${CODEX_CLI_URL})`,
          next: HARNESS_SETUP[0]!.install,
        }
      : {
          name: 'coding agent',
          ok: false,
          detail: `no coding agent CLI on PATH (claude, codex or opencode); ${configured.map(describe).join('; ')}`,
          fix: installFix(configured[0]!),
        };
  const checks: DoctorCheck[] = [
    agents.length > 0 ? { name: 'coding agent', ok: true, detail: `found ${agents.join(', ')}` } : missingRow,
  ];
  checks.push(...harnessInstallChecks(commandAvailable, tryExec));
  checks.push(...commandHarnessChecks(configured, commandAvailable));
  checks.push(...harnessSignInChecks(probes));
  return checks;
}

export function runDoctorChecks(probes: DoctorEnvProbes): DoctorCheck[] {
  const { commandAvailable, envPresent, tryExec, pathExists, distFreshness } = probes;
  const checks: DoctorCheck[] = [];

  const repoRoot = tryExec('git rev-parse --show-toplevel');
  checks.push(
    repoRoot !== null
      ? { name: 'git repository', ok: true, detail: repoRoot }
      : {
          name: 'git repository',
          ok: false,
          optional: true,
          detail: 'not inside a git repository; repo checks skipped',
          fix: NOT_IN_REPO_HINT,
        },
  );

  const repoSection = repoRoot === null ? {} : { section: REPO_SECTION };

  if (repoRoot === null) {
    checks.push({ name: 'git identity', ok: false, optional: true, detail: NOT_IN_REPO_SKIP_DETAIL });
  } else {
    const userName = tryExec('git config user.name');
    const userEmail = tryExec('git config user.email');
    if (userName && userEmail) {
      checks.push({ name: 'git identity', ok: true, detail: `${userName} <${userEmail}>`, ...repoSection });
    } else {
      const missing = [!userName && 'user.name', !userEmail && 'user.email'].filter(Boolean).join(' and ');
      checks.push({
        name: 'git identity',
        ok: false,
        detail: `${missing} not set`,
        next: !userName
          ? 'git config --global user.name "Your Name"'
          : 'git config --global user.email you@example.com',
        ...repoSection,
      });
    }
  }

  checks.push(...agentCliChecks(probes));

  if (!commandAvailable('gh')) {
    checks.push({
      name: 'gh auth',
      ok: false,
      detail: 'gh CLI not found on PATH',
      fix: 'install GitHub CLI: https://cli.github.com',
      next: 'gh auth login',
    });
  } else if (tryExec('gh auth status') === null) {
    checks.push({
      name: 'gh auth',
      ok: false,
      detail: 'gh is not authenticated',
      next: 'gh auth login',
    });
  } else {
    checks.push({ name: 'gh auth', ok: true, detail: 'authenticated' });
  }

  checks.push({ ...gitAuthCheck(repoRoot, tryExec), ...repoSection });

  if (envPresent('GITHUB_TOKEN')) {
    checks.push({ name: 'GitHub token', ok: true, detail: 'GITHUB_TOKEN set' });
  } else if (envPresent('GH_TOKEN')) {
    checks.push({ name: 'GitHub token', ok: true, detail: 'GH_TOKEN set' });
  } else {
    const token = tryExec('gh auth token');
    if (token) {
      checks.push({ name: 'GitHub token', ok: true, detail: 'using gh auth token' });
    } else {
      checks.push({
        name: 'GitHub token',
        ok: false,
        detail: 'no GITHUB_TOKEN, GH_TOKEN, or gh auth token',
        fix: `create a token at ${GITHUB_TOKENS_URL} and export it`,
        next: 'gh auth login',
      });
    }
  }

  checks.push(
    commandAvailable('npm')
      ? { name: 'npm', ok: true, detail: 'found on PATH' }
      : {
          name: 'npm',
          ok: false,
          detail: 'not found on PATH',
          fix: `install Node.js >= ${MIN_NODE_MAJOR} (which ships npm): https://nodejs.org`,
        },
  );

  if (repoRoot === null) {
    checks.push({
      name: 'git worktree clean',
      ok: false,
      optional: true,
      detail: NOT_IN_REPO_SKIP_DETAIL,
    });
  } else if (tryExec('git status --porcelain') === '') {
    checks.push({ name: 'git worktree clean', ok: true, detail: 'clean', ...repoSection });
  } else {
    checks.push({
      name: 'git worktree clean',
      ok: false,
      optional: true,
      detail: 'uncommitted changes present',
      fix: 'commit or stash changes before running the factory',
      ...repoSection,
    });
  }

  const sandboxRuntime = detectSandboxRuntime(probes.platform ?? process.platform, commandAvailable);
  checks.push(
    commandAvailable('codex')
      ? {
          name: 'codex sandbox',
          ok: true,
          optional: true,
          detail:
            sandboxRuntime === 'none'
              ? 'codex CLI found; no sandbox runtime, so codex runs with danger-full-access'
              : 'codex CLI found (sandboxed builds available)',
        }
      : {
          name: 'codex sandbox',
          ok: false,
          optional: true,
          detail: 'codex CLI not found; codex build routes unavailable',
          fix: 'install the codex CLI, or rely on claude routes',
        },
  );

  checks.push(
    sandboxRuntime !== 'none'
      ? { name: 'sandbox runtime', ok: true, optional: true, detail: `${sandboxRuntime} found` }
      : {
          name: 'sandbox runtime',
          ok: false,
          optional: true,
          detail: 'no sandbox-exec (macOS) or firejail (Linux) on PATH; agents will run uncontained',
          fix: 'install firejail (Linux) or run on macOS; see README Safety',
        },
  );

  if (repoRoot === null) {
    checks.push({
      name: '.factory initialized',
      ok: false,
      optional: true,
      detail: NOT_IN_REPO_SKIP_DETAIL,
    });
  } else if (pathExists(resolve(repoRoot, '.factory'))) {
    checks.push({ name: '.factory initialized', ok: true, detail: '.factory/ present', ...repoSection });
  } else {
    checks.push({
      name: '.factory initialized',
      ok: false,
      detail: '.factory/ missing',
      next: 'factory init',
      ...repoSection,
    });
  }

  if (distFreshness) {
    const { fresh, detail } = distFreshness();
    checks.push(
      fresh
        ? { name: 'compiled dist fresh', ok: true, detail }
        : {
            name: 'compiled dist fresh',
            ok: false,
            detail,
            fix: "run 'npm run build' at the monorepo root",
            next: 'npm run build',
          },
    );
  }

  return checks;
}

/** Row icon (#2550): ❌ only for a failure (counted in "N failed"), ➖ for a skipped row, ⚠️ for an optional warning. */
export function doctorCheckIcon(check: DoctorCheck): string {
  if (!check.ok && !check.optional) return '❌';
  if (/^skipped\b/.test(check.detail)) return '➖';
  return check.ok ? '✅' : '⚠️';
}

/** Outside a repo the models hint is skipped because `factory models --doctor` needs a repo (#2472). */
export function formatDoctorChecks(checks: DoctorCheck[], opts: { inRepo?: boolean } = {}): string {
  const lines = ['== factory doctor =='];
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  const sections = [...new Set(checks.flatMap((c) => (c.section === undefined ? [] : [c.section])))];
  const ordered = [
    ...checks.filter((c) => c.section === undefined),
    ...sections.flatMap((s) => checks.filter((c) => c.section === s)),
  ];

  let currentSection: string | undefined;
  for (const check of ordered) {
    if (check.ok) {
      passed++;
    } else if (check.optional) {
      warnings++;
    } else {
      failed++;
    }
    if (check.section !== undefined && check.section !== currentSection) {
      lines.push(`-- ${check.section} --`);
    }
    currentSection = check.section;
    const icon = doctorCheckIcon(check);
    lines.push(`  ${icon} ${check.name} - ${check.detail}`);
    if (!check.ok && check.fix) {
      lines.push(`       fix: ${check.fix}`);
    }
    if (!check.ok && check.next) {
      lines.push(`       next: ${check.next}`);
    }
  }

  lines.push(`${passed} passed, ${failed} failed, ${warnings} warnings`);
  lines.push('');
  lines.push(
    opts.inRepo === false
      ? `Model reachability: ${NOT_IN_REPO_SKIP_DETAIL}`
      : 'Model reachability: factory models --doctor',
  );

  return lines.join('\n');
}

export function doctorFailed(checks: DoctorCheck[]): boolean {
  return checks.some((c) => !c.ok && !c.optional);
}

/** The keychain service Claude Code uses for the default profile (CLAUDE_CONFIG_DIR unset). */
const DEFAULT_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Which Claude profile a keychain probe checked: the keychain service name and, for a
 *  non-default profile, the CLAUDE_CONFIG_DIR it belongs to. Absent = default profile. */
export interface KeychainProbeProfile {
  service?: string;
  configDir?: string;
}

/** Result of the macOS login-keychain probe for the Claude Code credential entry (#1014). */
export type KeychainProbeStatus =
  | { status: 'skipped'; detail: string }
  | ({ status: 'readable' } & KeychainProbeProfile)
  | ({ status: 'unreadable'; inTmux: boolean } & KeychainProbeProfile);

function loginFix(profile: KeychainProbeProfile): string {
  return profile.configDir ? `CLAUDE_CONFIG_DIR=${profile.configDir} claude` : '`claude`';
}

export function claudeKeychainCheck(probe: KeychainProbeStatus): DoctorCheck {
  if (probe.status === 'skipped') {
    return { name: 'claude keychain (macOS)', ok: true, optional: true, detail: probe.detail };
  }

  const service = probe.service ?? DEFAULT_KEYCHAIN_SERVICE;
  const profile = probe.configDir ? ` (profile CLAUDE_CONFIG_DIR=${probe.configDir})` : '';

  if (probe.status === 'readable') {
    return {
      name: 'claude keychain (macOS)',
      ok: true,
      detail: `login keychain entry '${service}'${profile} is readable in this context`,
    };
  }

  if (probe.inTmux) {
    return {
      name: 'claude keychain (macOS)',
      ok: false,
      detail: `security find-generic-password -s '${service}'${profile} failed inside tmux (SecKeychainSearchCopyNext); Claude OAuth refresh will fail with local_auth`,
      fix: 'run the factory from a context with login-keychain access, such as a LaunchAgent in the gui domain (launchctl bootstrap gui/$(id -u) …) or a login Terminal, not a raw tmux pane; see docs/runbooks/macos-keychain-launchagent.md',
    };
  }

  return {
    name: 'claude keychain (macOS)',
    ok: false,
    optional: true,
    detail: `security find-generic-password -s '${service}'${profile} failed; either never logged in, or this launch context cannot read the login keychain`,
    fix: `run ${loginFix(probe)} and complete /login (or export ANTHROPIC_API_KEY); if already logged in, see docs/runbooks/macos-keychain-launchagent.md`,
  };
}

/** Non-null when `factory run` must fail fast instead of claiming issues (#1014).
 *  Only the tmux-without-keychain differential is certain enough to abort a run on. */
export function keychainPreflightError(probe: KeychainProbeStatus): string | null {
  if (probe.status !== 'unreadable' || !probe.inTmux) return null;
  const service = probe.service ?? DEFAULT_KEYCHAIN_SERVICE;
  return `Claude Code credentials are not readable from this tmux session (security find-generic-password -s '${service}' failed / SecKeychainSearchCopyNext). OAuth refresh will fail and every claimed issue would spuriously park as local_auth. Launch the factory from a context with login-keychain access, such as a LaunchAgent in the gui domain (launchctl bootstrap gui/$(id -u) …) or a login Terminal, or export ANTHROPIC_API_KEY. See docs/runbooks/macos-keychain-launchagent.md.`;
}

/** Outcome of one `claude -p` probe: it succeeded, it failed, or it was not run. */
export type ClaudeAuthProbe = 'ok' | 'failed' | 'skipped';

export interface ClaudeAuthProbeResult {
  host: ClaudeAuthProbe;
  sandboxed: ClaudeAuthProbe;
  hostDetail: string;
  sandboxDetail: string;
}

const HOST_AUTH_CHECK = 'claude auth (host)';
const SANDBOX_AUTH_CHECK = 'claude auth (sandboxed)';

/** Reports host and sandboxed Claude auth as two separate checks (#1008). Only the
 *  differential — host ok, sandboxed failed — is a hard doctor failure; that is the one
 *  combination that proves the sandbox, not the credentials, is at fault. */
export function sandboxClaudeAuthChecks(result: ClaudeAuthProbeResult): DoctorCheck[] {
  const host: DoctorCheck =
    result.host === 'ok'
      ? { name: HOST_AUTH_CHECK, ok: true, detail: result.hostDetail }
      : result.host === 'skipped'
        ? { name: HOST_AUTH_CHECK, ok: true, optional: true, detail: result.hostDetail }
        : {
            name: HOST_AUTH_CHECK,
            ok: false,
            detail: result.hostDetail,
            fix: 'run `claude` and complete /login, then re-run `factory doctor`',
          };

  let sandboxed: DoctorCheck;
  if (result.sandboxed === 'ok') {
    sandboxed = { name: SANDBOX_AUTH_CHECK, ok: true, detail: result.sandboxDetail };
  } else if (result.sandboxed === 'skipped') {
    sandboxed = { name: SANDBOX_AUTH_CHECK, ok: true, optional: true, detail: result.sandboxDetail };
  } else if (result.host === 'ok') {
    sandboxed = {
      name: SANDBOX_AUTH_CHECK,
      ok: false,
      detail: `${result.sandboxDetail}; host claude auth is healthy, so the sandbox is blocking Claude credential refresh`,
      fix: 'check the sandbox write allowlist (~/.claude.json*, $CLAUDE_CONFIG_DIR when set, ~/Library/Keychains); as a stopgap run with FACTORY_SANDBOX=0',
    };
  } else {
    sandboxed = {
      name: SANDBOX_AUTH_CHECK,
      ok: false,
      optional: true,
      detail: `${result.sandboxDetail}; host claude auth is not healthy either, so this is not attributable to the sandbox`,
      fix: 'fix host claude auth first, then re-run `factory doctor`',
    };
  }

  return [host, sandboxed];
}

const AGENT_AUTH_CHECKS = new Set([...HARNESS_SETUP.map(({ cli }) => `${cli} signed in`), HOST_AUTH_CHECK]);

/** #2496: doctor fails on agent sign-in only when no installed agent is signed in. A logged-out
 *  agent is a warning while another one is signed in, and a hard failure when none is. Skipped
 *  probes (optional passes, e.g. a `<cli> signed in` row for a CLI not on PATH) never count as signed in. */
export function reconcileAgentAuthChecks(checks: DoctorCheck[]): DoctorCheck[] {
  const auth = checks.filter((c) => AGENT_AUTH_CHECKS.has(c.name));
  const anySignedIn = auth.some((c) => c.ok && c.optional !== true);
  return checks.map((c) => {
    if (!AGENT_AUTH_CHECKS.has(c.name) || c.ok) return c;
    return anySignedIn
      ? { ...c, optional: true, detail: `${c.detail} (another agent is signed in, so runs can still proceed)` }
      : { ...c, optional: false };
  });
}

/** index.ts's seams and helpers for `factory doctor`, built at call time so main() deps injection reaches the handler. */
export interface DoctorRuntime {
  shellOps: Required<Pick<CliDeps, 'exec' | 'execSync'>>;
  coreOps: Required<
    Pick<CliDeps, 'isCommandAvailable' | 'ModelRegistry' | 'probeDeclaredHarnesses' | 'reapOrphanProcesses'>
  >;
  internalOps: Required<
    Pick<
      CliDeps,
      | 'listOrphanContainers'
      | 'listMicroVms'
      | 'reapOrphanContainers'
      | 'reapOrphanMicroVm'
      | 'sweepWorktrees'
      | 'releaseStaleClaims'
    >
  >;
  configLoaders: Required<Pick<CliDeps, 'loadModelsConfig' | 'loadRepoConfig' | 'loadFactoryConfigForRepo'>>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  hasGitHubToken: () => boolean;
  scanGreenPrs: (ghRepo: string | undefined, octokit: Octokit | undefined) => Promise<GreenPrScanResult>;
  probeClaudeKeychain: () => KeychainProbeStatus;
  toLeaseRow: (health: LeaseHealth) => LeaseHealthRow;
  gcWorktreeSandbox: (
    sandboxCfg: FactoryConfig['sandbox'] | undefined,
    repoRoot: string,
  ) => WorktreeSandbox | undefined;
  repoConfigFileFor: (repoRoot: string, absPath: string) => { absPath: string; relPath: string };
  isCommandAvailableViaShell: (shell: DoctorRuntime['shellOps'], cmd: string) => boolean;
}

export async function cmdDoctor(
  opts: { reconcile?: boolean; probeInference?: boolean },
  rt: DoctorRuntime,
): Promise<void> {
  let repoRoot: string | null;
  try {
    repoRoot = rt.shellOps
      .execSync('git rev-parse --show-toplevel', {
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch {
    repoRoot = null;
  }

  const checks = runDoctorChecks({
    commandAvailable: rt.coreOps.isCommandAvailable,
    envPresent: (key) => !!process.env[key],
    tryExec: (cmd, opts) => {
      try {
        return rt.shellOps
          .execSync(cmd, {
            timeout: opts?.timeoutMs ?? 10_000,
            stdio: ['ignore', 'pipe', 'ignore'],
            ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
          })
          .trim();
      } catch {
        return null;
      }
    },
    pathExists: existsSync,
    distFreshness: distFreshnessProbe(import.meta.url),
    codexSessionState: () => codexChatgptSessionState(),
    claudeLoggedIn: () =>
      hasClaudeLoginEvidence({
        exec: (file, args) => {
          rt.shellOps.execSync([file, ...args].map(shellEscape).join(' '), { timeout: 10_000, stdio: 'ignore' });
        },
        fileExists: existsSync,
      }),
    claudeSessionState: () => claudeStoredSessionState(),
    localAuthFailure: (agent) => localAuthFailureSinceLogin(agent),
    opencodeLoggedIn: () => hasOpencodeLoginEvidence(),
    commandHarnesses: () =>
      repoRoot === null
        ? []
        : repoCommandHarnesses(
            rt.configLoaders.loadModelsConfig().harnesses,
            rt.configLoaders.loadRepoConfig(repoRoot)?.models?.registry,
          ),
  });

  // Only with --probe-inference: these send a real prompt (uses quota). Plain doctor makes no inference call.
  if (opts.probeInference) {
    const CLAUDE_AUTH_PROBE = 'claude -p "reply with exactly: ok"';
    const probeExec = (cmd: string): string | null => {
      try {
        return rt.shellOps.execSync(cmd, { timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        return null;
      }
    };

    let host: ClaudeAuthProbe = 'skipped';
    let hostDetail = 'skipped: claude CLI not on PATH';
    if (rt.coreOps.isCommandAvailable('claude')) {
      host = probeExec(CLAUDE_AUTH_PROBE) === null ? 'failed' : 'ok';
      hostDetail = host === 'ok' ? 'claude -p succeeded on the host' : 'claude -p failed on the host';
    }

    let sandboxed: ClaudeAuthProbe = 'skipped';
    let sandboxDetail = 'skipped: host claude auth was not verified';
    const runtimeAvailable = hasSandboxRuntime(process.platform, (cmd) =>
      rt.isCommandAvailableViaShell(rt.shellOps, cmd),
    );
    const skip = sandboxAuthSkipDetail({ runtimeAvailable, hostOk: host === 'ok', inRepo: repoRoot !== null });
    if (skip !== null) {
      sandboxDetail = skip;
    } else if (repoRoot !== null) {
      const policy = resolveSandboxPolicy(
        rt.configLoaders.loadFactoryConfigForRepo(getFactoryPaths(repoRoot).config).sandbox,
        {
          worktree: repoRoot,
          repoRoot,
          isAvailable: (cmd) => rt.isCommandAvailableViaShell(rt.shellOps, cmd),
        },
      );
      if (!policy) {
        sandboxDetail = 'skipped: sandbox disabled by config or FACTORY_SANDBOX';
      } else if (policy.runtime === 'none') {
        sandboxDetail = 'skipped: no sandbox runtime (sandbox-exec/firejail) on this host';
      } else if (policy.runtime === 'docker-sandbox') {
        sandboxDetail = 'skipped: docker-sandbox containment is the microVM, not command wrapping (#653)';
      } else {
        sandboxed = probeExec(wrapCommandInSandbox(CLAUDE_AUTH_PROBE, policy)) === null ? 'failed' : 'ok';
        sandboxDetail =
          sandboxed === 'ok'
            ? `claude -p succeeded under ${policy.runtime}`
            : `claude -p failed under ${policy.runtime} (local_auth)`;
      }
    }

    checks.push(...sandboxClaudeAuthChecks({ host, sandboxed, hostDetail, sandboxDetail }));
  }

  checks.push(claudeKeychainCheck(rt.probeClaudeKeychain()));
  checks.splice(0, checks.length, ...reconcileAgentAuthChecks(checks));

  if (repoRoot !== null) {
    const paths = getFactoryPaths(repoRoot);
    let factoryConfig: FactoryConfig;
    try {
      factoryConfig = rt.configLoaders.loadFactoryConfigForRepo(paths.config);
    } catch {
      factoryConfig = loadFactoryConfig(); // schema errors are reported by the config row (#2611)
    }
    const health = await inspectPortLeases({ registryFile: paths.ports });
    checks.push(...leaseChecks(health.map(rt.toLeaseRow)));

    const dockerAvailable = rt.coreOps.isCommandAvailable('docker');
    const orphanContainers = dockerAvailable ? await rt.internalOps.listOrphanContainers().catch(() => []) : [];
    checks.push(...orphanContainerChecks(orphanContainers.map((c) => c.name)));

    const sbxAvailable = rt.coreOps.isCommandAvailable('sbx');
    const activeVmNames = new Set(health.filter((h) => h.alive).map((h) => microVmName(h.lease.worktreeId)));
    const orphanVmNames = sbxAvailable
      ? (await rt.internalOps.listMicroVms()).filter((n) => !activeVmNames.has(n))
      : [];
    checks.push(...orphanMicroVmChecks(orphanVmNames));

    const sweepStatus = checkSweepHeartbeat(factoryConfig.sweep, process.env, defaultSweepHeartbeatDeps());
    const sweepCheck = sweepHeartbeatCheck(sweepStatus);
    if (sweepCheck) checks.push(sweepCheck);

    checks.push(stopSentinelCheck(readStopFileStatus(paths)));

    const eventsContent = existsSync(paths.events) ? readFileSync(paths.events, 'utf-8') : null;
    checks.push(eventLogCheck(eventsContent === null ? null : analyzeEventLog(eventsContent)));

    let constitution: ConfigLintInput['constitution'] = null;
    let loadError: string | undefined;
    try {
      constitution = new ConstitutionLoader().loadRepoConstitution(repoRoot, factoryConfig.paths?.constitution);
    } catch (err) {
      loadError = `cannot parse constitution: ${err instanceof Error ? err.message : String(err)}`;
    }
    checks.push(
      ...configLintChecks({ constitution, configFile: rt.repoConfigFileFor(repoRoot, paths.config) }, loadError),
    );

    try {
      const declared = Object.keys(rt.configLoaders.loadModelsConfig().harnesses ?? {});
      checks.push(
        ...modelsRegistryChecks(paths.config, rt.configLoaders.loadRepoConfig(repoRoot)?.models?.registry, [
          ...KNOWN_HARNESS_IDS,
          ...declared,
        ]),
      );
    } catch {
      // malformed config is reported by the load paths / `factory models --doctor`; doctor keeps going
    }

    let harnessProbes: DeclaredHarnessProbe[] = [];
    try {
      const registry = new rt.coreOps.ModelRegistry(
        applyRepoConfig(rt.configLoaders.loadModelsConfig(), rt.configLoaders.loadRepoConfig(repoRoot)),
      );
      harnessProbes = rt.coreOps.probeDeclaredHarnesses(registry);
    } catch {
      // models config problems are reported by `factory models --doctor`; doctor keeps going
    }
    checks.push(...declaredHarnessChecks(harnessProbes));

    // Full run-lifecycle reap (#998): dead-run worktrees and their branches. Uses the same
    // GitHub evidence and the same lock pairing as `factory worktree gc` (cmdWorktreeGc) —
    // a merged or closed PR is what makes a worktree reapable.
    const ghRepo = await rt.getGitHubRepo().catch(() => undefined);
    const octokit = ghRepo && rt.hasGitHubToken() ? rt.getOctokit() : undefined;

    // Green-and-ready PRs with no merge (#1000). Report only — doctor never lands a PR.
    checks.push(...unmergedGreenPrChecks(await rt.scanGreenPrs(ghRepo, octokit)));

    if (opts.reconcile) {
      if (orphanContainers.length > 0) {
        const reapedContainers = await rt.internalOps.reapOrphanContainers(orphanContainers);
        console.log(formatContainerReconcileReport(reapedContainers));
      }

      if (orphanVmNames.length > 0) {
        const reapedVms = await Promise.all(orphanVmNames.map((name) => rt.internalOps.reapOrphanMicroVm(name)));
        console.log(formatMicroVmReconcileReport(reapedVms));
      }

      const reaped = await reapStalePortLeases({ registryFile: paths.ports, lockDir: paths.portsLock });
      console.log(formatReconcileReport(reaped));

      if (reaped.length > 0) {
        const graceMs = resolveProcessGroupGraceMs(factoryConfig);
        const orphanEvents = await rt.coreOps.reapOrphanProcesses({ reaped, graceMs });
        for (const e of orphanEvents) {
          console.log(
            `reconcile: ${e.action === 'killed' ? 'killed' : 'found'} pid ${e.pid} (pgid ${e.pgid}, ${e.command}) squatting port ${e.port} of dead lane ${e.worktreeId}${e.action === 'reported' ? '; not factory-started, left running' : ''}`,
          );
        }
      }

      try {
        const gcLog = (type: EventKind, msg: string) => logEvent(paths.events, type, '-', msg);
        const gcSandbox = rt.gcWorktreeSandbox(factoryConfig.sandbox, repoRoot);
        const report = await withGitLock(repoRoot, () =>
          withFileLock(paths.gitLock, () =>
            rt.internalOps.sweepWorktrees(
              {
                repoRoot,
                ttlDays: factoryConfig.worktree.gcTtlDays,
                repo: ghRepo,
                branchPrefix: resolveBranchPrefix(),
              },
              { log: gcLog, octokit, sandbox: gcSandbox },
            ),
          ),
        );
        console.log(formatWorktreeReconcileReport(report.removed));
      } catch (err: any) {
        console.log(`reconcile: worktree sweep failed: ${err?.message ?? String(err)}`);
      }

      // Stale claim reap (#999): factory:in-progress claims naming a dead local pid go back to
      // factory:queued so the next run can claim them with no manual label surgery.
      try {
        if (ghRepo && octokit) {
          const [owner, repoName] = ghRepo.split('/');
          const released = await rt.internalOps.releaseStaleClaims({
            client: createOctokitQueueClient(octokit),
            owner,
            repo: repoName,
          });
          console.log(formatClaimReconcileReport(released));
        } else {
          console.log('reconcile: skipping stale claims: no GitHub repo or token');
        }
      } catch (err: any) {
        console.log(`reconcile: stale claim release failed: ${err?.message ?? String(err)}`);
      }
    }
  }

  console.log(formatDoctorChecks(checks, { inRepo: repoRoot !== null }));
  if (doctorFailed(checks)) process.exit(1);
}
