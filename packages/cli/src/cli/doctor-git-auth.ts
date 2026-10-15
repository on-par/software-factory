import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { type DoctorCheck, type DoctorExecOptions, NOT_IN_REPO_SKIP_DETAIL } from './doctor-types.js';

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

/** GitHub's SSH endpoints: ssh.github.com is the port-443 alternate for github.com (#2940). */
export const GITHUB_SSH_SIBLING_HOSTS: Readonly<Record<string, string>> = {
  'github.com': 'ssh.github.com',
  'ssh.github.com': 'github.com',
};
const SSH_CONFIG_TIMEOUT_MS = 5_000;

/** Identity files `ssh -G <host>` would offer, `~` expanded; null when ssh could not run (#2940).
 *  The host is shell-safe: it passed sshOriginHost's hostname regex or is a constant sibling. */
export function sshIdentityFiles(
  host: string,
  tryExec: (cmd: string, opts?: DoctorExecOptions) => string | null,
  home: string = homedir(),
): string[] | null {
  const out = tryExec(`ssh -G ${host}`, { timeoutMs: SSH_CONFIG_TIMEOUT_MS });
  if (out === null) return null;
  const files: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^identityfile\s+(.+)$/i.exec(line.trim());
    const value = m?.[1]?.trim();
    if (!value || value.toLowerCase() === 'none') continue;
    if (value === '~') files.push(home);
    else if (value.startsWith('~/')) files.push(resolve(home, value.slice(2)));
    else files.push(value);
  }
  return files;
}

/** Detects a Host alias mismatch (#2940): ssh offers no existing key for the origin host, but its
 *  GitHub sibling host does. Null when the host has no sibling (no `ssh -G` runs) or in any other case. */
export function sshHostAliasMismatch(
  host: string,
  tryExec: (cmd: string, opts?: DoctorExecOptions) => string | null,
  fileExists: (path: string) => boolean,
  home: string = homedir(),
): { originHost: string; siblingHost: string } | null {
  const origin = host.toLowerCase();
  const sibling = GITHUB_SSH_SIBLING_HOSTS[origin];
  if (!sibling) return null;
  const originFiles = sshIdentityFiles(origin, tryExec, home);
  if (originFiles === null || originFiles.some(fileExists)) return null;
  const siblingFiles = sshIdentityFiles(sibling, tryExec, home);
  if (siblingFiles === null || !siblingFiles.some(fileExists)) return null;
  return { originHost: origin, siblingHost: sibling };
}

/** Remedy for a Host alias mismatch (#2940). Names only bare hosts, never the origin URL. */
export function gitAuthSshAliasFix(originHost: string, siblingHost: string): string {
  return `origin host \`${originHost}\` gets no existing SSH key, but \`${siblingHost}\` does: add \`${originHost}\` to the \`Host ${siblingHost}\` line in \`~/.ssh/config\` (e.g. \`Host ${siblingHost} ${originHost}\`), then re-run \`factory doctor\``;
}

/** Git-auth check (#2482, #2483): skipped, never failing, outside a git repository or without
 *  an origin remote. Otherwise runs a non-interactive `git ls-remote` against origin and fails
 *  when it cannot authenticate. SSH origins get SSH guidance instead of `gh auth setup-git`
 *  (#2939), and a Host alias mismatch is named when detected (#2940). The output never echoes the origin URL, which may hold a token; only a bare
 *  SSH hostname may appear. */
export function gitAuthCheck(
  repoRoot: string | null,
  tryExec: (cmd: string, opts?: DoctorExecOptions) => string | null,
  fileExists: (path: string) => boolean = existsSync,
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
    const ssh = sshOriginHost(origin);
    if (ssh) {
      const mismatch = ssh.host ? sshHostAliasMismatch(ssh.host, tryExec, fileExists) : null;
      if (mismatch) {
        return {
          name: GIT_AUTH_CHECK,
          ok: false,
          detail: `git could not authenticate to origin over SSH: ssh offers no existing key for ${mismatch.originHost}, but ${mismatch.siblingHost} has one in ~/.ssh/config`,
          fix: gitAuthSshAliasFix(mismatch.originHost, mismatch.siblingHost),
          next: `ssh -T git@${mismatch.originHost}`,
        };
      }
      return {
        name: GIT_AUTH_CHECK,
        ok: false,
        detail: 'git could not authenticate to origin over SSH non-interactively (prompting disabled)',
        fix: gitAuthSshFix(ssh.host),
        ...(ssh.host ? { next: `ssh -T git@${ssh.host}` } : {}),
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
