import { redactGitHubCredentials } from '../utils/github-credentials.js';

export class GitHubScopeError extends Error {
  readonly phase: string;
  readonly method: string;
  readonly route: string;
  readonly fix: string;

  constructor(phase: string, method: string, route: string, reason: string, fix: string) {
    const where = method ? `GitHub call ${method} ${route} refused` : 'GitHub credential refused';
    super(redactGitHubCredentials(`${where} in phase ${phase}: ${reason}. Fix: ${fix}`));
    this.name = 'GitHubScopeError';
    this.phase = phase;
    this.method = method;
    this.route = route;
    this.fix = fix;
  }
}
