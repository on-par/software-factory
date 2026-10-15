import { describe, expect, it } from 'vitest';

import { formatDoctorChecks, runDoctorChecks } from './doctor.js';
import {
  GIT_AUTH_FIX,
  gitAuthCheck,
  gitAuthSshAliasFix,
  gitAuthSshFix,
  sshHostAliasMismatch,
  sshIdentityFiles,
  sshOriginHost,
} from './doctor-git-auth.js';

describe('gitAuthCheck SSH origins (#2939)', () => {
  const failingWith = (origin: string) => gitAuthCheck('/repo', (cmd) => (cmd.includes('ls-remote') ? null : origin));
  const SSH_ORIGINS = ['git@github.com:o/r.git', 'ssh://git@github.com/o/r.git', 'ssh://git@github.com:2222/o/r.git'];

  it('with an SSH origin, a failing probe gives SSH guidance and never mentions gh auth setup-git', () => {
    for (const origin of SSH_ORIGINS) {
      const check = failingWith(origin);
      expect(check.ok).toBe(false);
      expect(check.optional).toBeUndefined();
      expect(check.fix).toContain('ssh -T git@github.com');
      expect(check.fix).toContain('ssh-add -l');
      expect(check.next).toBe('ssh -T git@github.com');
      for (const text of [check.fix, check.detail, check.next, formatDoctorChecks([check])]) {
        expect(text).not.toContain('gh auth setup-git');
      }
    }
  });

  it('with an HTTPS origin, a failing probe keeps GIT_AUTH_FIX while an SSH origin does not', () => {
    for (const origin of ['https://github.com/o/r.git', 'https://user:tok@github.com/o/r.git']) {
      const check = failingWith(origin);
      expect(check.fix).toBe(GIT_AUTH_FIX);
      expect(check.next).toBe('gh auth setup-git');
    }
    expect(failingWith('git@github.com:o/r.git').fix).not.toBe(GIT_AUTH_FIX);
  });

  it('a failing probe never echoes the origin URL, user, port or path for SSH or HTTPS origins', () => {
    const origins = [
      ...SSH_ORIGINS,
      'https://github.com/o/r.git',
      'https://user:tok@github.com/o/r.git',
      'ssh://deploy@github.com:2222/secret-org/secret-repo.git',
    ];
    for (const origin of origins) {
      const check = failingWith(origin);
      for (const text of [check.detail, check.fix, check.next ?? '']) {
        for (const leak of [origin, 'secret-org', 'secret-repo', 'deploy', '2222', 'tok']) {
          expect(text).not.toContain(leak);
        }
      }
    }
    expect(failingWith('ssh://deploy@github.com:2222/secret-org/secret-repo.git').fix).toContain(
      'ssh -T git@github.com',
    );
  });

  it('sshOriginHost classifies git URL transports', () => {
    for (const o of [
      'https://github.com/o/r.git',
      'https://user:tok@github.com/o/r.git',
      'http://host/o/r.git',
      '/srv/repos/r.git',
      'file:///srv/r.git',
      'C:\\repos\\r',
      'not a url',
      '',
    ]) {
      expect(sshOriginHost(o)).toBeNull();
    }
    for (const o of [
      ...SSH_ORIGINS,
      'git+ssh://git@github.com/o/r.git',
      'ssh+git://git@github.com/o/r.git',
      'github.com:o/r.git',
      '  git@github.com:o/r.git\n',
    ]) {
      expect(sshOriginHost(o)).toEqual({ host: 'github.com' });
    }
    expect(sshOriginHost('gh-work:o/r.git')).toEqual({ host: 'gh-work' });
    expect(sshOriginHost('ssh://git@[::1]/o/r.git')).toEqual({ host: null });
  });

  it('gitAuthSshFix uses a <host> placeholder when the host is unknown', () => {
    expect(gitAuthSshFix(null)).toContain('ssh -T git@<host>');
    const check = failingWith('ssh://git@[::1]/o/r.git');
    expect(check.fix).toContain('ssh -T git@<host>');
    expect(check.next).toBeUndefined();
  });
});

describe('gitAuthCheck SSH host alias mismatch (#2940)', () => {
  const MISSING = ['identityfile /keys/missing_rsa', 'identityfile /keys/missing_ed25519'].join('\n');
  const GH_KEYS = ['identityfile /keys/gh_ed25519', 'identityfile /keys/missing_rsa'].join('\n');

  function setup(origin: string, sshG: Record<string, string | null>, existing: string[]) {
    const calls: string[] = [];
    const tryExec = (cmd: string): string | null => {
      calls.push(cmd);
      if (cmd.includes('ls-remote')) return null;
      if (cmd.startsWith('ssh -G ')) return sshG[cmd.slice('ssh -G '.length)] ?? null;
      return origin;
    };
    const files = new Set(existing);
    return { calls, check: gitAuthCheck('/repo', tryExec, (p) => files.has(p)) };
  }

  it('names the Host alias mismatch when only the sibling host has an existing identity file', () => {
    const cases = [
      {
        origin: 'ssh://git@ssh.github.com:443/on-par/software-factory.git',
        host: 'ssh.github.com',
        sibling: 'github.com',
      },
      { origin: 'git@github.com:o/r.git', host: 'github.com', sibling: 'ssh.github.com' },
      { origin: 'ssh://git@SSH.GitHub.com:443/o/r.git', host: 'ssh.github.com', sibling: 'github.com' },
    ];
    for (const c of cases) {
      const { check } = setup(c.origin, { [c.host]: MISSING, [c.sibling]: GH_KEYS }, ['/keys/gh_ed25519']);
      expect(check.ok).toBe(false);
      expect(check.fix).toContain(c.host);
      expect(check.fix).toContain(`\`Host ${c.sibling}\``);
      expect(check.fix).toContain('~/.ssh/config');
      expect(check.next).toBe(`ssh -T git@${c.host}`);
      for (const text of [check.fix, check.detail, check.next, formatDoctorChecks([check])]) {
        expect(text).not.toContain('gh auth setup-git');
      }
    }
  });

  it('falls through to the generic SSH fix when there is no alias mismatch', () => {
    const origin = 'ssh://git@ssh.github.com:443/o/r.git';
    const cases: Array<{ sshG: Record<string, string | null>; existing: string[] }> = [
      { sshG: { 'ssh.github.com': MISSING, 'github.com': GH_KEYS }, existing: ['/keys/missing_rsa'] },
      { sshG: { 'ssh.github.com': MISSING, 'github.com': MISSING }, existing: [] },
      { sshG: { 'github.com': GH_KEYS }, existing: ['/keys/gh_ed25519'] },
      { sshG: { 'ssh.github.com': MISSING }, existing: ['/keys/gh_ed25519'] },
      { sshG: { 'ssh.github.com': 'identityfile none', 'github.com': 'identityfile none' }, existing: ['none'] },
    ];
    for (const c of cases) {
      const { check } = setup(origin, c.sshG, c.existing);
      expect(check.fix).toBe(gitAuthSshFix('ssh.github.com'));
    }
    const gitlab = setup('git@gitlab.com:o/r.git', {}, []);
    expect(gitlab.check.fix).toBe(gitAuthSshFix('gitlab.com'));
    expect(gitlab.calls.some((c) => c.startsWith('ssh -G'))).toBe(false);
  });

  it('the alias mismatch row never echoes the origin URL, user, port or path', () => {
    const origin = 'ssh://deploy@ssh.github.com:443/secret-org/secret-repo.git';
    const { check } = setup(origin, { 'ssh.github.com': MISSING, 'github.com': GH_KEYS }, ['/keys/gh_ed25519']);
    expect(check.fix).toContain('`Host github.com`');
    for (const text of [check.detail, check.fix, check.next ?? '']) {
      for (const leak of [origin, 'secret-org', 'secret-repo', 'deploy', '443']) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it('sshIdentityFiles expands ~, skips none, is case-insensitive and passes null through', () => {
    const out = 'IdentityFile ~/.ssh/id_rsa\nidentityfile none\nidentityfile ~\nidentityfile /abs/key\nhostname x';
    expect(sshIdentityFiles('h', () => out, '/home/u')).toEqual(['/home/u/.ssh/id_rsa', '/home/u', '/abs/key']);
    expect(sshIdentityFiles('h', () => '', '/home/u')).toEqual([]);
    expect(sshIdentityFiles('h', () => null, '/home/u')).toBeNull();
  });

  it('sshHostAliasMismatch expands ~ against the given home', () => {
    const exec = (cmd: string) => (cmd === 'ssh -G github.com' ? 'identityfile ~/.ssh/gh' : 'identityfile ~/.ssh/none');
    expect(sshHostAliasMismatch('Ssh.GitHub.com', exec, (p) => p === '/h/.ssh/gh', '/h')).toEqual({
      originHost: 'ssh.github.com',
      siblingHost: 'github.com',
    });
  });

  it('gitAuthSshAliasFix names both hosts and the config file', () => {
    const fix = gitAuthSshAliasFix('ssh.github.com', 'github.com');
    expect(fix).toContain('`Host github.com`');
    expect(fix).toContain('~/.ssh/config');
    expect(fix).toContain('ssh.github.com');
    expect(fix).not.toContain('gh auth setup-git');
  });
});

describe('runDoctorChecks git auth wiring (#2940)', () => {
  it('passes pathExists into the SSH host alias mismatch check', () => {
    const checks = runDoctorChecks({
      commandAvailable: () => true,
      envPresent: () => true,
      tryExec: (cmd) => {
        if (cmd.includes('git rev-parse')) return '/repo';
        if (cmd.includes('ls-remote')) return null;
        if (cmd === 'git remote get-url origin') return 'ssh://git@ssh.github.com:443/o/r.git';
        if (cmd === 'ssh -G ssh.github.com') return 'identityfile /keys/none';
        if (cmd === 'ssh -G github.com') return 'identityfile /keys/gh';
        return '';
      },
      pathExists: (p) => p === '/keys/gh',
      platform: 'darwin',
      claudeLoggedIn: () => true,
      opencodeLoggedIn: () => true,
    });
    expect(checks.find((c) => c.name === 'git auth')?.fix).toContain('`Host github.com`');
  });
});
