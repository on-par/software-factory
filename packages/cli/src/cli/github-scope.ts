import type { Octokit } from '@octokit/rest';
import type { FailurePhase, FactoryConfig } from '@on-par/factory-core';
import { getFactoryPaths, loadFactoryConfigForRepo } from '@on-par/factory-core';
import {
  createGitHubCredentialBroker,
  installGitHubScopeGuard,
  PhaseCredentialHolder,
  resolveGitHubCredentialSource,
  resolveGitHubCredentialsConfig,
  type GitHubCredentialsSettings,
  type ResolvedGitHubCredentialSource,
} from '@on-par/factory-core/internal';
import { createFactoryOctokit, type FactoryOctokitOptions } from './octokit.js';

export { createFactoryOctokit };

export interface ScopedOctokitOptions extends FactoryOctokitOptions {
  phase?: FailurePhase | 'land';
  repo?: string;
  settings?: GitHubCredentialsSettings;
}

export interface LocalShell {
  execSync: (command: string, options?: { timeout?: number }) => string;
}

const sources = new WeakMap<object, ResolvedGitHubCredentialSource>();
const DEFAULT_SETTINGS: GitHubCredentialsSettings = { allowAmbientToken: false };
const GIT_PROBE_TIMEOUT_MS = 5_000;

export function credentialSourceOf(octokit: unknown): ResolvedGitHubCredentialSource | undefined {
  return typeof octokit === 'object' && octokit !== null ? sources.get(octokit) : undefined;
}

export function createScopedFactoryOctokit(input: {
  repo: string;
  phase: FailurePhase | 'land';
  settings: GitHubCredentialsSettings;
  env: NodeJS.ProcessEnv;
  resolveAmbient: () => string | undefined;
  options?: FactoryOctokitOptions;
}): { octokit: Octokit; source: ResolvedGitHubCredentialSource } {
  const { repo, phase, settings, env, resolveAmbient, options } = input;
  const source = resolveGitHubCredentialSource(settings, env, resolveAmbient);
  if (source.source.kind === 'ambient') {
    const octokit = createFactoryOctokit(resolveAmbient(), { ...options, resolveToken: resolveAmbient });
    sources.set(octokit, source);
    return { octokit, source };
  }
  const rest: FactoryOctokitOptions = { ...options };
  delete rest.resolveToken;
  const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo, source: source.source }), {
    checkToken: resolveAmbient,
    initialPhase: phase,
  });
  const octokit = installGitHubScopeGuard(createFactoryOctokit(undefined, rest), { repo, holder });
  sources.set(octokit, source);
  return { octokit, source };
}

function probe(shell: LocalShell, command: string): string | undefined {
  try {
    return shell.execSync(command, { timeout: GIT_PROBE_TIMEOUT_MS }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function repoFromRemote(shell: LocalShell): string | undefined {
  const remote = probe(shell, 'git remote get-url origin');
  return remote
    ?.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
    ?.slice(1, 3)
    .join('/');
}

function settingsFromConfig(shell: LocalShell): GitHubCredentialsSettings {
  const root = probe(shell, 'git rev-parse --show-toplevel');
  if (!root) return DEFAULT_SETTINGS;
  const config: FactoryConfig = loadFactoryConfigForRepo(getFactoryPaths(root).config);
  return resolveGitHubCredentialsConfig(config);
}

export function createLocalOctokit(
  shell: LocalShell,
  resolveAmbient: () => string | undefined,
  env: NodeJS.ProcessEnv,
  options: ScopedOctokitOptions = {},
): Octokit {
  const { phase, repo, settings, ...clientOptions } = options;
  const target = repo ?? (phase ? repoFromRemote(shell) : undefined);
  if (!target) {
    return createFactoryOctokit(resolveAmbient(), { ...clientOptions, resolveToken: resolveAmbient });
  }
  return createScopedFactoryOctokit({
    repo: target,
    phase: phase ?? 'plan',
    settings: settings ?? settingsFromConfig(shell),
    env,
    resolveAmbient,
    options: clientOptions,
  }).octokit;
}
