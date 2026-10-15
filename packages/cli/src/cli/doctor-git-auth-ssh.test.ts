import { describe, expect, it } from 'vitest';

import { formatDoctorChecks, GIT_AUTH_FIX, gitAuthCheck, gitAuthSshFix, sshOriginHost } from './doctor.js';

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
