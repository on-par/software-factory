import type { GitHubPhase, PhaseGitHubScope } from './matrix.js';

export type GitHubCredentialSourceKind = 'app-installation' | 'fine-grained' | 'ambient';

export type AmbientReason = 'opt-in' | 'unconfigured';

export interface PhaseCredential {
  phase: GitHubPhase;
  kind: GitHubCredentialSourceKind;
  token: string;
  expiresAt?: string;
  release(): Promise<void>;
}

export interface GitHubCredentialSource {
  kind: GitHubCredentialSourceKind;
  ambientReason?: AmbientReason;
  lease(phase: GitHubPhase, repo: string, scope: PhaseGitHubScope): Promise<PhaseCredential>;
}
