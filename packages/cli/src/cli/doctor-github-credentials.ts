import { resolveGitHubCredentialSource, resolveGitHubCredentialsConfig } from '@on-par/factory-core/internal';
import type { DoctorCheck } from './doctor.js';

const NAME = 'GitHub credential source';
const DOCS = 'docs/ops/github-credentials.md';

export function githubCredentialSourceCheck(
  config: Parameters<typeof resolveGitHubCredentialsConfig>[0],
  env: NodeJS.ProcessEnv,
): DoctorCheck {
  const { source } = resolveGitHubCredentialSource(resolveGitHubCredentialsConfig(config), env, () => undefined);
  if (source.kind === 'app-installation') {
    return { name: NAME, ok: true, detail: 'GitHub App installation tokens, one per phase' };
  }
  if (source.kind === 'fine-grained') {
    return { name: NAME, ok: true, detail: 'fine-grained per-phase tokens (FACTORY_GITHUB_TOKEN_<PHASE>)' };
  }
  if (source.ambientReason === 'opt-in') {
    return {
      name: NAME,
      ok: false,
      optional: true,
      detail: 'ambient operator token in use (github.credentials.allowAmbientToken)',
      fix: `configure github.credentials.app or FACTORY_GITHUB_TOKEN_<PHASE> and drop allowAmbientToken; see ${DOCS}`,
    };
  }
  return {
    name: NAME,
    ok: false,
    optional: true,
    detail:
      'no scoped GitHub credential configured; the ambient token is used and this fails in the next release (ADR-0160)',
    fix: `configure github.credentials.app or FACTORY_GITHUB_TOKEN_<PHASE>, or set allowAmbientToken; see ${DOCS}`,
  };
}
