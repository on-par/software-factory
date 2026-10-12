// packages/cli/src/cli/doctor.ts — `factory doctor` environment preflight

import { resolve } from 'node:path';

import type { DeclaredHarnessProbe } from '@on-par/factory-core';
import { detectSandboxRuntime } from '@on-par/factory-core';

import { MIN_NODE_MAJOR } from '../node-version.js';
import { availableAgentClis, CLAUDE_CODE_URL, CODEX_CLI_URL, GITHUB_TOKENS_URL } from './first-run.js';

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
}

export interface DoctorExecOptions {
  /** Extra env vars merged over process.env for this command. */
  env?: Record<string, string>;
  /** Kill the command after this many ms; the probe then returns null. */
  timeoutMs?: number;
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
}

export const NOT_IN_REPO_HINT = 'cd into your repo, then run factory doctor again';

/** Detail for every repo wired-up row when doctor runs outside a git repository (#2554). */
export const NOT_IN_REPO_SKIP_DETAIL = `skipped — not inside a git repository; ${NOT_IN_REPO_HINT}`;

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
  if (!opts.runtimeAvailable) return 'skipped — no sandbox runtime (sandbox-exec/firejail) on this host';
  if (!opts.hostOk) return 'skipped — host claude auth was not verified';
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

const CODEX_LOGIN_FIX =
  'run `codex login` (Sign in with ChatGPT, for Plus or Pro plans), `codex login --with-api-key` (API billing), or `codex login --device-auth` on a headless machine';

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
    return { name: GIT_AUTH_CHECK, ok: true, optional: true, detail: 'skipped — no origin remote configured' };
  }
  // An empty string is exit 0 with no HEAD ref (an empty repo): still authenticated.
  const probe = tryExec(GIT_AUTH_PROBE_CMD, { env: { ...GIT_AUTH_PROBE_ENV }, timeoutMs: GIT_AUTH_PROBE_TIMEOUT_MS });
  if (probe === null) {
    return {
      name: GIT_AUTH_CHECK,
      ok: false,
      detail: 'git could not authenticate to origin non-interactively (prompting disabled)',
      fix: GIT_AUTH_FIX,
    };
  }
  return { name: GIT_AUTH_CHECK, ok: true, detail: 'git can authenticate to origin non-interactively' };
}

export interface HarnessSetup {
  section: string;
  cli: string;
  install: string;
}

/** One doctor section per built-in harness (#2555), in display order. */
export const HARNESS_SETUP: readonly HarnessSetup[] = [
  { section: 'Claude Code', cli: 'claude', install: 'npm install -g @anthropic-ai/claude-code' },
  { section: 'Codex', cli: 'codex', install: 'npm install -g @openai/codex' },
  { section: 'OpenCode', cli: 'opencode', install: 'npm install -g opencode-ai' },
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

/** Coding agent prerequisites: at least one agent CLI is required; each CLI is then reported
 *  on its own optional line, with Codex sign-in reported separately from installation (#1269, #2422, #2555). */
export function agentCliChecks(
  commandAvailable: (cmd: string) => boolean,
  tryExec: (cmd: string) => string | null,
  codexSessionState: () => 'ok' | 'refresh-pending' | 'unusable' | 'unknown' = () => 'unknown',
): DoctorCheck[] {
  const found = availableAgentClis(commandAvailable);
  const checks: DoctorCheck[] = [
    found.length > 0
      ? { name: 'coding agent', ok: true, detail: `found ${found.join(', ')}` }
      : {
          name: 'coding agent',
          ok: false,
          detail: 'no coding agent CLI on PATH (claude, codex or opencode)',
          fix: `install Claude Code (${CLAUDE_CODE_URL}) or the Codex CLI (${CODEX_CLI_URL})`,
        },
  ];
  checks.push(...harnessInstallChecks(commandAvailable, tryExec));
  if (found.includes('codex')) {
    const method = codexAuthMethod(tryExec('codex login status 2>&1'));
    const session = method === 'ChatGPT' ? codexSessionState() : 'unknown';
    checks.push(
      session === 'unusable'
        ? {
            name: 'codex auth',
            ok: false,
            optional: found.length > 1,
            detail:
              'ChatGPT session in auth.json is unusable (unreadable, or no valid access token and no refresh token)',
            fix: CODEX_LOGIN_FIX,
          }
        : session === 'refresh-pending'
          ? {
              name: 'codex auth',
              ok: true,
              detail:
                'logged in with ChatGPT; access token expired, codex refreshes it on the next run (run `codex login` if that run fails with 401)',
            }
          : method
            ? {
                name: 'codex auth',
                ok: true,
                detail:
                  method === 'ChatGPT'
                    ? 'logged in with ChatGPT; runs draw on your ChatGPT plan limits (manage usage in ChatGPT settings)'
                    : `logged in with ${method}`,
              }
            : {
                name: 'codex auth',
                // Required only when codex is the sole agent: then nothing else can run.
                ok: false,
                optional: found.length > 1,
                detail: 'codex CLI installed but not logged in',
                fix: CODEX_LOGIN_FIX,
              },
    );
  }
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
          detail: 'not inside a git repository — repo checks skipped',
          fix: NOT_IN_REPO_HINT,
        },
  );

  if (repoRoot === null) {
    checks.push({ name: 'git identity', ok: false, optional: true, detail: NOT_IN_REPO_SKIP_DETAIL });
  } else {
    const userName = tryExec('git config user.name');
    const userEmail = tryExec('git config user.email');
    if (userName && userEmail) {
      checks.push({ name: 'git identity', ok: true, detail: `${userName} <${userEmail}>` });
    } else {
      const missing = [!userName && 'user.name', !userEmail && 'user.email'].filter(Boolean).join(' and ');
      checks.push({
        name: 'git identity',
        ok: false,
        detail: `${missing} not set`,
        fix: 'git config --global user.name "Your Name" && git config --global user.email you@example.com',
      });
    }
  }

  checks.push(...agentCliChecks(commandAvailable, tryExec, probes.codexSessionState));

  if (!commandAvailable('gh')) {
    checks.push({
      name: 'gh auth',
      ok: false,
      detail: 'gh CLI not found on PATH',
      fix: 'install GitHub CLI and run `gh auth login`',
    });
  } else if (tryExec('gh auth status') === null) {
    checks.push({
      name: 'gh auth',
      ok: false,
      detail: 'gh is not authenticated',
      fix: 'install GitHub CLI and run `gh auth login`',
    });
  } else {
    checks.push({ name: 'gh auth', ok: true, detail: 'authenticated' });
  }

  checks.push(gitAuthCheck(repoRoot, tryExec));

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
    checks.push({ name: 'git worktree clean', ok: true, detail: 'clean' });
  } else {
    checks.push({
      name: 'git worktree clean',
      ok: false,
      optional: true,
      detail: 'uncommitted changes present',
      fix: 'commit or stash changes before running the factory',
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
              ? 'codex CLI found — no sandbox runtime, so codex runs with danger-full-access'
              : 'codex CLI found (sandboxed builds available)',
        }
      : {
          name: 'codex sandbox',
          ok: false,
          optional: true,
          detail: 'codex CLI not found — codex build routes unavailable',
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
          detail: 'no sandbox-exec (macOS) or firejail (Linux) on PATH — agents will run uncontained',
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
    checks.push({ name: '.factory initialized', ok: true, optional: true, detail: '.factory/ present' });
  } else {
    checks.push({
      name: '.factory initialized',
      ok: false,
      optional: true,
      detail: '.factory/ missing',
      fix: 'run `factory init`',
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
    lines.push(`  ${icon} ${check.name} — ${check.detail}`);
    if (!check.ok && check.fix) {
      lines.push(`       fix: ${check.fix}`);
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
      detail: `security find-generic-password -s '${service}'${profile} failed inside tmux (SecKeychainSearchCopyNext) — Claude OAuth refresh will fail with local_auth`,
      fix: 'run the factory from a context with login-keychain access — a LaunchAgent in the gui domain (launchctl bootstrap gui/$(id -u) …) or a login Terminal, not a raw tmux pane — see docs/runbooks/macos-keychain-launchagent.md',
    };
  }

  return {
    name: 'claude keychain (macOS)',
    ok: false,
    optional: true,
    detail: `security find-generic-password -s '${service}'${profile} failed — either never logged in, or this launch context cannot read the login keychain`,
    fix: `run ${loginFix(probe)} and complete /login (or export ANTHROPIC_API_KEY); if already logged in, see docs/runbooks/macos-keychain-launchagent.md`,
  };
}

/** Non-null when `factory run` must fail fast instead of claiming issues (#1014).
 *  Only the tmux-without-keychain differential is certain enough to abort a run on. */
export function keychainPreflightError(probe: KeychainProbeStatus): string | null {
  if (probe.status !== 'unreadable' || !probe.inTmux) return null;
  const service = probe.service ?? DEFAULT_KEYCHAIN_SERVICE;
  return `Claude Code credentials are not readable from this tmux session (security find-generic-password -s '${service}' failed / SecKeychainSearchCopyNext). OAuth refresh will fail and every claimed issue would spuriously park as local_auth. Launch the factory from a context with login-keychain access — a LaunchAgent in the gui domain (launchctl bootstrap gui/$(id -u) …) or a login Terminal — or export ANTHROPIC_API_KEY. See docs/runbooks/macos-keychain-launchagent.md.`;
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
      detail: `${result.sandboxDetail} — host claude auth is healthy, so the sandbox is blocking Claude credential refresh`,
      fix: 'check the sandbox write allowlist (~/.claude.json*, $CLAUDE_CONFIG_DIR when set, ~/Library/Keychains); as a stopgap run with FACTORY_SANDBOX=0',
    };
  } else {
    sandboxed = {
      name: SANDBOX_AUTH_CHECK,
      ok: false,
      optional: true,
      detail: `${result.sandboxDetail} — host claude auth is not healthy either, so this is not attributable to the sandbox`,
      fix: 'fix host claude auth first, then re-run `factory doctor`',
    };
  }

  return [host, sandboxed];
}

const AGENT_AUTH_CHECKS = new Set(['codex auth', HOST_AUTH_CHECK]);

/** #2496: doctor fails on agent sign-in only when no installed agent is signed in. A logged-out
 *  agent is a warning while another one is signed in, and a hard failure when none is. Skipped
 *  probes (optional passes, e.g. claude not on PATH) never count as signed in. */
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

export interface LeaseHealthRow {
  worktreeId: string;
  branch: string;
  port: number;
  pid: number;
  alive: boolean;
  reason?: 'dead-pid' | 'missing-worktree';
  portSquatted?: boolean;
}

export function leaseChecks(rows: LeaseHealthRow[]): DoctorCheck[] {
  if (rows.length === 0) {
    return [{ name: 'port leases', ok: true, optional: true, detail: 'no active leases' }];
  }

  return rows.map((row) => {
    if (row.alive) {
      return {
        name: `port lease :${row.port}`,
        ok: true,
        optional: true,
        detail: `${row.worktreeId} — port ${row.port}, pid ${row.pid}, live`,
      };
    }

    const squatted = row.portSquatted ? '; port still in use by another process' : '';
    return {
      name: `port lease :${row.port}`,
      ok: false,
      optional: true,
      detail: `${row.worktreeId} — port ${row.port}, pid ${row.pid}, stale (${row.reason})${squatted}`,
      fix: 'run `factory doctor --reconcile` to reclaim stale leases',
    };
  });
}

export interface EventLogIntegrity {
  total: number;
  unparseable: number;
}

export function analyzeEventLog(content: string): EventLogIntegrity {
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  let unparseable = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      unparseable++;
    }
  }
  return { total: lines.length, unparseable };
}

export function eventLogCheck(integrity: EventLogIntegrity | null): DoctorCheck {
  if (integrity === null) {
    return { name: 'event log integrity', ok: true, optional: true, detail: 'no events.ndjson yet' };
  }
  if (integrity.total === 0) {
    return { name: 'event log integrity', ok: true, optional: true, detail: 'events.ndjson is empty' };
  }
  const pct = ((integrity.unparseable / integrity.total) * 100).toFixed(1);
  if (integrity.unparseable === 0) {
    return {
      name: 'event log integrity',
      ok: true,
      optional: true,
      detail: `${integrity.total} lines, 0 unparseable (0.0%)`,
    };
  }
  return {
    name: 'event log integrity',
    ok: false,
    optional: true,
    detail: `${integrity.unparseable} of ${integrity.total} lines unparseable (${pct}%)`,
    fix: 'historical corruption from pre-lock parallel writes; appends are now serialized — metrics over this file carry this error bar',
  };
}

export interface ReapRow {
  name: string;
  removed: boolean;
  detail: string;
}

export function orphanContainerChecks(names: readonly string[]): DoctorCheck[] {
  if (names.length === 0) {
    return [{ name: 'orphan containers', ok: true, detail: 'no orphan sf-job-*/factory.managed containers' }];
  }
  return names.map((name) => ({
    name: `orphan container ${name}`,
    ok: false,
    detail: `${name} is stopped and not tied to any running job`,
    fix: 'run `factory doctor --reconcile` to remove it and its anonymous volumes',
  }));
}

export function orphanMicroVmChecks(names: readonly string[]): DoctorCheck[] {
  if (names.length === 0) {
    return [{ name: 'orphan sbx VMs', ok: true, detail: 'no orphan factory-* sbx VMs' }];
  }
  return names.map((name) => ({
    name: `orphan sbx VM ${name}`,
    ok: false,
    detail: `${name} has no active lane holding its worktree`,
    fix: 'run `factory doctor --reconcile` to remove it via `sbx rm --force`',
  }));
}

export function formatContainerReconcileReport(reaped: ReapRow[]): string {
  if (reaped.length === 0) return 'reconcile: no orphan containers';
  return reaped
    .map((r) =>
      r.removed
        ? `reconcile: removed container ${r.name}`
        : `reconcile: failed to remove container ${r.name} — ${r.detail}`,
    )
    .join('\n');
}

export function formatMicroVmReconcileReport(reaped: ReapRow[]): string {
  if (reaped.length === 0) return 'reconcile: no orphan sbx VMs';
  return reaped
    .map((r) =>
      r.removed
        ? `reconcile: removed sbx VM ${r.name} (sbx rm --force)`
        : `reconcile: failed to remove sbx VM ${r.name} — ${r.detail}`,
    )
    .join('\n');
}

export function formatReconcileReport(
  reaped: Array<{ lease: { worktreeId: string; port: number }; reason: string }>,
): string {
  if (reaped.length === 0) return 'reconcile: no stale leases';

  return reaped
    .map((r) => `reconcile: freed port ${r.lease.port} (worktree ${r.lease.worktreeId}, reason ${r.reason})`)
    .join('\n');
}

/** One worktree the reconcile pass removed. Structurally the subset of core's `GcCandidate`
 *  that the report renders — kept local so `doctor.ts` stays dependency-free and unit-testable. */
export interface ReconciledWorktree {
  path: string;
  branch: string | null;
  reason: string;
  branchDeleted: boolean;
}

export function formatWorktreeReconcileReport(removed: ReconciledWorktree[]): string {
  if (removed.length === 0) return 'reconcile: no dead-run worktrees';

  return removed
    .map((w) => {
      const branchLabel = w.branch ?? 'detached';
      const deleted = w.branchDeleted ? `, deleted branch ${w.branch}` : '';
      return `reconcile: removed worktree ${w.path} (branch ${branchLabel}, reason ${w.reason})${deleted}`;
    })
    .join('\n');
}

/** One claim the reconcile pass put back in the queue. Structurally the subset of core's
 *  `StaleClaimRelease` that the report renders — kept local so `doctor.ts` stays
 *  dependency-free and unit-testable. */
export interface ReleasedClaim {
  issue: number;
  expiresAt: number;
  released: boolean;
  detail?: string;
}

export function formatClaimReconcileReport(released: ReleasedClaim[]): string {
  if (released.length === 0) return 'reconcile: no stale claims';

  return released
    .map((c) =>
      c.released
        ? `reconcile: released issue #${c.issue} back to factory:queued (lease expired at ${c.expiresAt})`
        : `reconcile: failed to release issue #${c.issue} (lease expired at ${c.expiresAt}) — ${c.detail ?? 'unknown error'}`,
    )
    .join('\n');
}

/** One green-and-ready PR nobody merged. Structurally the subset of core's `UnmergedGreenPr`
 *  the report renders — kept local so `doctor.ts` stays dependency-free and unit-testable. */
export interface UnmergedGreenPrRow {
  number: number;
  branch: string;
  issue: number | null;
  ageHours: number;
}

/** Outcome of the green-PR scan: it ran, it was skipped (no repo/token), or it failed. */
export type GreenPrScanResult =
  | { status: 'ok'; rows: UnmergedGreenPrRow[] }
  | { status: 'skipped'; detail: string }
  | { status: 'failed'; detail: string };

const GREEN_PR_CHECK = 'green PRs awaiting merge';

export function unmergedGreenPrChecks(result: GreenPrScanResult): DoctorCheck[] {
  if (result.status === 'skipped') {
    return [{ name: GREEN_PR_CHECK, ok: true, optional: true, detail: result.detail }];
  }
  if (result.status === 'failed') {
    return [
      {
        name: GREEN_PR_CHECK,
        ok: false,
        optional: true,
        detail: `scan failed — ${result.detail}`,
        fix: 'check `gh auth status` and network access, then re-run `factory doctor`',
      },
    ];
  }
  if (result.rows.length === 0) {
    return [{ name: GREEN_PR_CHECK, ok: true, optional: true, detail: 'no green-and-ready PRs awaiting merge' }];
  }
  return result.rows.map((row) => ({
    name: `green PR #${row.number}`,
    ok: false,
    optional: true,
    detail: `${row.issue === null ? 'owning issue unknown' : `issue #${row.issue}`} — green and ready on ${row.branch}, open ${row.ageHours}h, not merged`,
    fix: `review and merge #${row.number} (or close it) — the factory never auto-merges an orphaned PR`,
  }));
}

/** One doctor check per user-declared harness, from its `probe` result. */
export function declaredHarnessChecks(probes: DeclaredHarnessProbe[]): DoctorCheck[] {
  return probes.map((p): DoctorCheck => {
    const name = `harness ${p.harness}`;
    if (p.status === 'available') return { name, ok: true, detail: `available (probe: ${p.probe})` };
    if (p.status === 'unavailable') {
      return {
        name,
        ok: false,
        detail: `unavailable — probe \`${p.probe}\` failed: ${p.detail}`,
        fix: 'install the agent CLI on PATH or fix the "probe" command in the models config harnesses section',
      };
    }
    return {
      name,
      ok: false,
      optional: true,
      detail: 'unverified — no probe configured',
      fix: 'add a "probe" command (exit 0 = reachable) to the harness in the models config',
    };
  });
}

const REGISTRY_CHECK = 'models.registry';

/** One failed check per models.registry entry whose harness is missing or unknown;
 *  a single ok row when every entry is valid; nothing when there is no registry. */
export function modelsRegistryChecks(
  configPath: string,
  registry: Readonly<Record<string, { harness?: string }>> | undefined,
  validHarnesses: readonly string[],
): DoctorCheck[] {
  const entries = Object.entries(registry ?? {});
  if (entries.length === 0) return [];
  const failed: DoctorCheck[] = [];
  for (const [id, def] of entries) {
    const field = `models.registry.${id}.harness`;
    const name = `${REGISTRY_CHECK} ${id}`;
    if (def.harness === undefined || def.harness.trim() === '') {
      failed.push({
        name,
        ok: false,
        detail: `${configPath}: ${field} is missing`,
        fix: `set "harness" to one of: ${validHarnesses.join(', ')}`,
      });
    } else if (!validHarnesses.includes(def.harness)) {
      failed.push({
        name,
        ok: false,
        detail: `${configPath}: ${field} '${def.harness}' is not a known harness (valid harnesses: ${validHarnesses.join(', ')})`,
        fix: 'use a built-in harness id or declare it under "harnesses" in the models config',
      });
    }
  }
  if (failed.length > 0) return failed;
  const n = entries.length;
  return [{ name: REGISTRY_CHECK, ok: true, detail: `${n} entr${n === 1 ? 'y' : 'ies'} valid (${configPath})` }];
}
