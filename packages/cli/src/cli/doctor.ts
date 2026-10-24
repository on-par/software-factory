// packages/cli/src/cli/doctor.ts — `factory doctor` environment preflight

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

import { npmCheck, resolveVerifyCommands, verifyCommandChecks, withPathResults } from './doctor-verify.js';
import { configLintChecks, declaredHarnessChecks, modelsRegistryChecks } from './doctor-config.js';
import { failoverProviderChecks } from './doctor-failover-providers.js';
import { agentMemoryChecks } from './doctor-agent-memory.js';
import { factoryIgnoredChecks } from './doctor-factory-ignored.js';
import {
  analyzeEventLog,
  eventLogCheck,
  formatContainerReconcileReport,
  formatMicroVmReconcileReport,
  formatReconcileReport,
  formatWorktreeReconcileReport,
  type GreenPrScanResult,
  leaseChecks,
  type LeaseHealthRow,
  type StatelessLaneScanResult,
  statelessLaneIssueChecks,
  orphanContainerChecks,
  orphanMicroVmChecks,
  unmergedGreenPrChecks,
} from './doctor-health.js';
import { OPENCODE_LIVE_AUTH_CHECK, opencodeLiveAuthCheck, runOpencodeAuthProbe } from './doctor-opencode-probe.js';
import { resolveDoctorHarnesses } from './doctor-harness-view.js';
import { reconcileQueue } from './doctor-queue-reconcile.js';
import { HARNESS_SETUP, harnessInstallChecks, readyAgents, skipMissingAgentCheck } from './doctor-harness.js';
import { failMissingAgentCheck as failMissing } from './doctor-harness.js';
export { HARNESS_SETUP, harnessInstallChecks, readyAgents };
import { availableAgentClis, CLAUDE_CODE_URL, CODEX_CLI_URL, GITHUB_TOKENS_URL } from './first-run.js';
import type { CliDeps } from './index.js';
import { riskPolicyCheck } from './risk-policy.js';
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
   *  (#2733, #2890); reads local state only, never refreshes. */
  localAuthFailure?: (agent: 'claude' | 'codex' | 'opencode') => { agent: string; at: string } | null;
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

/** Classifies an origin URL's transport (#2939). Returns null when it is not SSH (ssh://,
 *  git+ssh://, ssh+git:// or scp-style `[user@]host:path`), else the bare hostname, or null
 *  when the host is not a safe hostname. Never returns the user, port or path. */
export function sshOriginHost(origin: string): { host: string | null } | null {
  const url = origin.trim();
  let candidate: string;
  const scheme = /^(?:ssh|git\+ssh|ssh\+git):\/\/(?:[^@/]*@)?([^/:]*)/i.exec(url);
  if (scheme) {
    candidate = scheme[1] ?? '';
  } else if (url.includes('://')) {
    return null;
  } else {
    const scp = /^(?:([^@/:\s]+)@)?([^/:\s]+):/.exec(url);
    if (!scp || (scp[2] ?? '').length <= 1) return null;
    candidate = scp[2] ?? '';
  }
  return { host: /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(candidate) ? candidate : null };
}

/** Remedy for a failing SSH origin (#2939); `<host>` stands in when the host is unknown. */
export function gitAuthSshFix(host: string | null): string {
  const target = host ?? '<host>';
  return `origin uses SSH: test with \`ssh -T git@${target}\` and check your SSH key is loaded (\`ssh-add -l\`), then re-run \`factory doctor\``;
}

type TryExec = (cmd: string, opts?: DoctorExecOptions) => string | null;
/** GitHub's SSH endpoints: ssh.github.com is the port-443 alternate for github.com (#2940). */
const GITHUB_SSH_SIBLING_HOSTS: Readonly<Record<string, string>> = {
  'github.com': 'ssh.github.com',
  'ssh.github.com': 'github.com',
};

/** Identity files `ssh -G <host>` offers, `~` expanded; null when ssh could not run (#2940). The host is shell-safe. */
export function sshIdentityFiles(host: string, tryExec: TryExec, home: string = homedir()): string[] | null {
  const out = tryExec(`ssh -G ${host}`, { timeoutMs: 5_000 });
  if (out === null) return null;
  const values = out.split(/\r?\n/).map((line) => /^identityfile\s+(.+)$/i.exec(line.trim())?.[1]?.trim());
  return values
    .filter((v): v is string => !!v && v.toLowerCase() !== 'none')
    .map((v) => (v === '~' ? home : v.startsWith('~/') ? resolve(home, v.slice(2)) : v));
}

/** Host alias mismatch (#2940): no existing key for the origin host, but its GitHub sibling has one. */
export function sshHostAliasMismatch(
  host: string,
  tryExec: TryExec,
  fileExists: (p: string) => boolean,
  home?: string,
): { originHost: string; siblingHost: string } | null {
  const origin = host.toLowerCase();
  const sibling = GITHUB_SSH_SIBLING_HOSTS[origin];
  if (!sibling || sshIdentityFiles(origin, tryExec, home)?.some(fileExists) !== false) return null;
  return sshIdentityFiles(sibling, tryExec, home)?.some(fileExists)
    ? { originHost: origin, siblingHost: sibling }
    : null;
}

export function gitAuthSshAliasFix(originHost: string, siblingHost: string): string {
  return `origin host \`${originHost}\` gets no existing SSH key, but \`${siblingHost}\` does: add \`${originHost}\` to the \`Host ${siblingHost}\` line in \`~/.ssh/config\` (e.g. \`Host ${siblingHost} ${originHost}\`), then re-run \`factory doctor\``;
}

/** Git-auth check (#2482, #2483): skipped, never failing, outside a git repository or without
 *  an origin remote. Otherwise runs a non-interactive `git ls-remote` against origin and fails
 *  when it cannot authenticate. SSH origins get SSH guidance instead of `gh auth setup-git`
 *  (#2939), and a Host alias mismatch is named when detected (#2940). The output never echoes the
 *  origin URL, which may hold a token; only a bare SSH hostname may appear. */
export function gitAuthCheck(
  repoRoot: string | null,
  tryExec: TryExec,
  fileExists: (path: string) => boolean = existsSync,
): DoctorCheck {
  if (repoRoot === null) {
    return { name: GIT_AUTH_CHECK, ok: true, optional: true, detail: NOT_IN_REPO_SKIP_DETAIL };
  }
  const origin = tryExec('git remote get-url origin');
  if (!origin) {
    return { name: GIT_AUTH_CHECK, ok: true, optional: true, detail: 'skipped: no origin remote configured' };
  }
  // An empty string is exit 0 with no HEAD ref (an empty repo): still authenticated.
  const probe = tryExec(GIT_AUTH_PROBE_CMD, { env: { ...GIT_AUTH_PROBE_ENV }, timeoutMs: GIT_AUTH_PROBE_TIMEOUT_MS });
  if (probe === null) {
    const ssh = sshOriginHost(origin);
    if (ssh) {
      const m = ssh.host ? sshHostAliasMismatch(ssh.host, tryExec, fileExists) : null;
      const host = m?.originHost ?? ssh.host;
      return {
        name: GIT_AUTH_CHECK,
        ok: false,
        detail: m
          ? `git could not authenticate to origin over SSH: ssh offers no existing key for ${m.originHost}, but ${m.siblingHost} has one in ~/.ssh/config`
          : 'git could not authenticate to origin over SSH non-interactively (prompting disabled)',
        fix: m ? gitAuthSshAliasFix(m.originHost, m.siblingHost) : gitAuthSshFix(ssh.host),
        ...(host ? { next: `ssh -T git@${host}` } : {}),
      };
    }
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

const SIGN_IN_EVIDENCE: Readonly<Record<string, string>> = {
  claude: 'no ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or stored login',
  codex:
    'no CODEX_API_KEY or codex login; API billing: codex login --with-api-key; headless: codex login --device-auth',
  opencode: 'no OPENCODE_API_KEY or stored auth login',
  pi: 'no OPENROUTER_API_KEY, OPENCODE_API_KEY or AZURE_OPENAI_API_KEY set; Pi may still hold a stored /login (factory models --doctor runs pi auth check)',
};

function safeOr<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const safe = (fn: (() => boolean) | undefined): boolean => safeOr(fn, false);
const safeState = (fn: (() => string) | undefined): string => safeOr(fn, 'unknown');

/** One `<cli> signed in` row per installed harness CLI (#2556, #2631), judged only from local evidence: an env key,
 *  stored credentials, or `codex login status`. Never runs inference and never prints a secret. */
export function harnessSignInChecks(probes: DoctorEnvProbes): DoctorCheck[] {
  const { commandAvailable, envPresent, tryExec } = probes;
  const found = availableAgentClis(commandAvailable);
  return HARNESS_SETUP.filter(({ harnessId }) => isHarnessCliPresent(harnessId, commandAvailable)).map(
    ({ section, cli, login, next, envKeys }): DoctorCheck => {
      const name = `${cli} signed in`;
      const fix = `sign in to ${section}: ${login}`;
      if (cli === 'claude' || cli === 'codex' || cli === 'opencode') {
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
            detail: `the most recent run failed sign-in (local_auth) at ${failure.at} and there has been no login since; re-run ${cli === 'opencode' ? login : `${cli} login`}`,
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
        next: next ?? login,
      };
    },
  );
}

const safeList = (fn: (() => ConfiguredCommandHarness[]) | undefined): ConfiguredCommandHarness[] => safeOr(fn, []);

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
  return `install ${h.executable ?? 'the agent CLI'} on PATH or fix harnesses.${h.harness}.command in .factory/config.yaml`;
}

/** Coding agent prerequisites: at least one agent CLI is required; each CLI is then reported
 *  on its own optional line, with sign-in reported separately from installation (#1269, #2422, #2555, #2556).
 *  The codex sandbox note is folded into the ok `codex installed` row, so each agent has one row (#2997).
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
          detail: 'no coding agent CLI on PATH (claude, codex, opencode or pi)',
          fix: `install Claude Code (${CLAUDE_CODE_URL}) or the Codex CLI (${CODEX_CLI_URL})`,
          next: HARNESS_SETUP[0]!.install,
        }
      : {
          name: 'coding agent',
          ok: false,
          detail: `no coding agent CLI on PATH (claude, codex, opencode or pi); ${configured.map(describe).join('; ')}`,
          fix: installFix(configured[0]!),
        };
  const codexSandbox =
    detectSandboxRuntime(probes.platform ?? process.platform, commandAvailable) === 'none'
      ? 'no sandbox runtime; codex runs in its own workspace-write sandbox'
      : 'sandboxed builds available';
  const checks: DoctorCheck[] = [
    agents.length > 0 ? { name: 'coding agent', ok: true, detail: `found ${agents.join(', ')}` } : missingRow,
    ...harnessInstallChecks(commandAvailable, tryExec).map((c) =>
      c.name === 'codex installed' && c.ok
        ? { ...c, detail: `${c.detail}; ${codexSandbox}` }
        : failMissing(c, !agents.length),
    ),
  ];
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

  checks.push({ ...gitAuthCheck(repoRoot, tryExec, pathExists), ...repoSection });

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

  const hasPackageJson = repoRoot === null || pathExists(resolve(repoRoot, 'package.json'));
  checks.push(npmCheck(commandAvailable('npm'), hasPackageJson));

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
    checks.push(...factoryIgnoredChecks(repoRoot, tryExec, pathExists).map((c) => ({ ...c, ...repoSection })));
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

  const ready = readyAgents(checks);
  const readySuffix = ready.length > 0 ? `; ready: ${ready.join(', ')}` : '';
  lines.push(`${passed} passed, ${failed} failed, ${warnings} warnings${readySuffix}`);
  lines.push('');
  lines.push(
    opts.inRepo === false
      ? `Model reachability: ${NOT_IN_REPO_SKIP_DETAIL}`
      : 'Model reachability: not checked. Run `factory models --doctor`',
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

/** The keychain row(s) for doctor: none off macOS, where the login keychain does not apply (#2998). */
export function claudeKeychainChecks(platform: NodeJS.Platform, probe: () => KeychainProbeStatus): DoctorCheck[] {
  return platform === 'darwin' ? [claudeKeychainCheck(probe())] : [];
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

const AGENT_AUTH_CHECKS = new Set([
  ...HARNESS_SETUP.map(({ cli }) => `${cli} signed in`),
  HOST_AUTH_CHECK,
  OPENCODE_LIVE_AUTH_CHECK,
]);

/** #2496: doctor fails on agent sign-in only when no installed agent is signed in. A logged-out
 *  agent is a warning while another one is signed in, and a hard failure when none is. Skipped probes
 *  never count as signed in. #2996: not-installed agents become ➖ skipped info while one is signed in. */
export function reconcileAgentAuthChecks(checks: DoctorCheck[]): DoctorCheck[] {
  const anySignedIn = checks.some((c) => AGENT_AUTH_CHECKS.has(c.name) && c.ok && c.optional !== true);
  return checks.map((row) => {
    const c = anySignedIn ? skipMissingAgentCheck(row) : row;
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
      | 'pollBlockedParks'
    >
  >;
  configLoaders: Required<Pick<CliDeps, 'loadModelsConfig' | 'loadRepoConfig' | 'loadFactoryConfigForRepo'>>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  hasGitHubToken: () => boolean;
  scanGreenPrs: (ghRepo: string | undefined, octokit: Octokit | undefined) => Promise<GreenPrScanResult>;
  scanStatelessLaneIssues: (
    ghRepo: string | undefined,
    octokit: Octokit | undefined,
  ) => Promise<StatelessLaneScanResult>;
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
  opts: { reconcile?: boolean; probeInference?: boolean; json?: boolean },
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
  const harnessView = repoRoot === null ? null : resolveDoctorHarnesses(rt.configLoaders, repoRoot);

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
    commandHarnesses: () => (harnessView?.merged ? repoCommandHarnesses(harnessView.merged, harnessView.registry) : []),
  });
  checks.push(...failoverProviderChecks(rt, repoRoot));

  // Only with --probe-inference: these send a real prompt (claude, opencode; uses quota). Plain doctor makes no inference call.
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
        const probe = { ...policy, networkMode: 'report' as const }; // no lane proxy in doctor; enforce would block (#2215)
        sandboxed = probeExec(wrapCommandInSandbox(CLAUDE_AUTH_PROBE, probe)) === null ? 'failed' : 'ok';
        sandboxDetail =
          sandboxed === 'ok'
            ? `claude -p succeeded under ${policy.runtime}`
            : `claude -p failed under ${policy.runtime} (local_auth)`;
      }
    }
    checks.push(...sandboxClaudeAuthChecks({ host, sandboxed, hostDetail, sandboxDetail }));

    checks.push(opencodeLiveAuthCheck(runOpencodeAuthProbe(rt, repoRoot)));
  }

  checks.push(...claudeKeychainChecks(process.platform, rt.probeClaudeKeychain));
  checks.splice(0, checks.length, ...reconcileAgentAuthChecks(checks));

  let verifyRows: ReturnType<typeof withPathResults> = [];
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
    const verify = await resolveVerifyCommands(repoRoot);
    verifyRows = withPathResults(verify.rows, rt.coreOps.isCommandAvailable);
    checks.push(
      ...verifyCommandChecks(verify, {
        requireTests: constitution?.requireTests === true,
        commandAvailable: rt.coreOps.isCommandAvailable,
      }),
    );
    checks.push(riskPolicyCheck(repoRoot), ...(await agentMemoryChecks(repoRoot)));

    // A malformed config never aborts doctor; a merge failure is reported once, below.
    const view = harnessView ?? { declaredIds: [] };
    const registryRows = modelsRegistryChecks(paths.config, view.registry, [
      ...new Set([...KNOWN_HARNESS_IDS, ...view.declaredIds]),
    ]);
    checks.push(...registryRows);
    if (view.mergeError !== undefined && registryRows.every((r) => r.ok)) {
      checks.push({
        name: 'models config',
        section: REPO_SECTION,
        ok: false,
        detail: view.mergeError,
        fix: 'fix the harnesses or models section in .factory/config.yaml (built-in harness ids cannot be redeclared)',
      });
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
    checks.push(...statelessLaneIssueChecks(await rt.scanStatelessLaneIssues(ghRepo, octokit)));

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

      await reconcileQueue(rt.internalOps, ghRepo, octokit, getFactoryPaths(repoRoot).events);
    }
  }

  const text = formatDoctorChecks(checks, { inRepo: repoRoot !== null });
  console.log(opts.json ? JSON.stringify({ ok: !doctorFailed(checks), checks, verify: verifyRows }, null, 2) : text);
  if (doctorFailed(checks)) process.exit(1);
}
