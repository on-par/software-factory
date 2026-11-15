import type { FailurePhase } from '../types/index.js';
import { appInstallationSource } from './app-token.js';
import { GitHubScopeError } from './errors.js';
import { permissionList, scopeForPhase, type GitHubPhase, type PhaseGitHubScope } from './matrix.js';
import type { AmbientReason, GitHubCredentialSource, PhaseCredential } from './types.js';

export interface GitHubCredentialsSettings {
  allowAmbientToken: boolean;
  app?: { appId: number; installationId: number };
}

export interface ResolvedGitHubCredentialSource {
  source: GitHubCredentialSource;
  warning?: string;
}

export interface GitHubCredentialBroker {
  source: GitHubCredentialSource;
  lease(phase: GitHubPhase): Promise<PhaseCredential | null>;
}

const FINE_GRAINED_PHASES = ['plan', 'ship', 'land'] as const;
const PRIVATE_KEY_ENV = 'FACTORY_GITHUB_APP_PRIVATE_KEY';
const AMBIENT_OPT_IN_WARNING = 'ambient operator GitHub token in use (github.credentials.allowAmbientToken)';
const AMBIENT_UNCONFIGURED_WARNING =
  'no scoped GitHub credential configured; using the ambient token. This fails in the next release (ADR-0160); configure github.credentials.app or FACTORY_GITHUB_TOKEN_<PHASE>, or set allowAmbientToken';

const noRelease = async (): Promise<void> => {};

function tokenEnvName(phase: string): string {
  return `FACTORY_GITHUB_TOKEN_${phase.toUpperCase()}`;
}

export function fineGrainedSource(env: NodeJS.ProcessEnv): GitHubCredentialSource {
  return {
    kind: 'fine-grained',
    async lease(phase, repo, scope) {
      const token = env[tokenEnvName(phase)]?.trim();
      if (!token) {
        throw new GitHubScopeError(
          phase,
          '',
          '',
          `phase ${phase} has no GitHub credential`,
          `set ${tokenEnvName(phase)} to a fine-grained token for ${repo} with ${permissionList(scope)}`,
        );
      }
      return { phase, kind: 'fine-grained', token, release: noRelease };
    },
  };
}

export function ambientSource(resolveToken: () => string | undefined, reason: AmbientReason): GitHubCredentialSource {
  return {
    kind: 'ambient',
    ambientReason: reason,
    async lease(phase, repo) {
      const token = resolveToken()?.trim();
      if (!token) {
        throw new GitHubScopeError(
          phase,
          '',
          '',
          `no ambient GitHub token available for ${repo}`,
          'export GITHUB_TOKEN or run `gh auth login`',
        );
      }
      return { phase, kind: 'ambient', token, release: noRelease };
    },
  };
}

function missingPrivateKeySource(): GitHubCredentialSource {
  return {
    kind: 'app-installation',
    async lease(phase) {
      throw new GitHubScopeError(
        phase,
        '',
        '',
        `github.credentials.app is configured but ${PRIVATE_KEY_ENV} is not set`,
        `export ${PRIVATE_KEY_ENV} with the App private key PEM`,
      );
    },
  };
}

export function resolveGitHubCredentialSource(
  settings: GitHubCredentialsSettings,
  env: NodeJS.ProcessEnv,
  resolveAmbient: () => string | undefined,
  transport: {
    fetch?: typeof fetch;
    now?: () => number;
    onReleaseError?: (phase: GitHubPhase, err: unknown) => void;
  } = {},
): ResolvedGitHubCredentialSource {
  if (settings.app) {
    const privateKey = env[PRIVATE_KEY_ENV]?.trim();
    if (!privateKey) return { source: missingPrivateKeySource() };
    return {
      source: appInstallationSource({
        appId: settings.app.appId,
        installationId: settings.app.installationId,
        privateKey,
        fetch: transport.fetch,
        now: transport.now,
        onReleaseError: transport.onReleaseError,
      }),
    };
  }
  if (FINE_GRAINED_PHASES.some((phase) => env[tokenEnvName(phase)]?.trim())) {
    return { source: fineGrainedSource(env) };
  }
  if (settings.allowAmbientToken) {
    return { source: ambientSource(resolveAmbient, 'opt-in'), warning: AMBIENT_OPT_IN_WARNING };
  }
  return { source: ambientSource(resolveAmbient, 'unconfigured'), warning: AMBIENT_UNCONFIGURED_WARNING };
}

export function createGitHubCredentialBroker(opts: {
  repo: string;
  source: GitHubCredentialSource;
}): GitHubCredentialBroker {
  const { repo, source } = opts;
  return {
    source,
    async lease(phase) {
      const scope = scopeForPhase(phase);
      return scope ? source.lease(phase, repo, scope) : null;
    },
  };
}

export type HolderPhase = FailurePhase | 'land';

export interface HolderState {
  phase: HolderPhase;
  mode: 'scoped' | 'none' | 'passthrough';
  credential?: PhaseCredential;
  scope?: PhaseGitHubScope;
  failure?: Error;
}

export class PhaseCredentialHolder {
  mergeAllowed = false;
  readonly initialPhase: HolderPhase;
  private readonly broker: GitHubCredentialBroker;
  private readonly checkTokenSource: () => string | undefined;
  private readonly onReleaseError: ((phase: HolderPhase, err: unknown) => void) | undefined;
  private state: HolderState | undefined;
  private entering: Promise<void> | undefined;

  constructor(
    broker: GitHubCredentialBroker,
    opts: {
      checkToken: () => string | undefined;
      initialPhase?: HolderPhase;
      onReleaseError?: (phase: HolderPhase, err: unknown) => void;
    },
  ) {
    this.broker = broker;
    this.checkTokenSource = opts.checkToken;
    this.onReleaseError = opts.onReleaseError;
    this.initialPhase = opts.initialPhase ?? 'plan';
  }

  checkToken(): string | undefined {
    return this.checkTokenSource()?.trim() || undefined;
  }

  current(): HolderState | undefined {
    return this.state;
  }

  ensureEntered(): Promise<void> {
    return this.entering ?? this.enter(this.initialPhase);
  }

  enter(phase: HolderPhase): Promise<void> {
    const run = (this.entering ?? Promise.resolve()).then(() => this.transition(phase));
    this.entering = run;
    return run;
  }

  private async transition(phase: HolderPhase): Promise<void> {
    this.mergeAllowed = false;
    await this.releaseQuietly(this.state);
    if (phase === 'check') {
      this.state = { phase, mode: 'passthrough' };
      return;
    }
    if (phase === 'build') {
      this.state = { phase, mode: 'none' };
      return;
    }
    try {
      const credential = await this.broker.lease(phase);
      this.state = credential
        ? { phase, mode: 'scoped', credential, scope: scopeForPhase(phase) ?? undefined }
        : { phase, mode: 'none' };
    } catch (err) {
      this.state = { phase, mode: 'scoped', failure: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  private async releaseQuietly(state: HolderState | undefined): Promise<void> {
    try {
      await state?.credential?.release();
    } catch (err) {
      this.onReleaseError?.(state?.phase ?? this.initialPhase, err);
    }
  }

  async close(): Promise<void> {
    await this.entering;
    const closing = this.state;
    if (this.state) this.state = { ...this.state, credential: undefined };
    this.mergeAllowed = false;
    await this.releaseQuietly(closing);
  }
}
