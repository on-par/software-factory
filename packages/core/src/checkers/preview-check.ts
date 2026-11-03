import { lookup } from 'node:dns/promises';

import type { PreviewConfig } from '../config/preview-section.js';
import type { CommandResult, RunCommandOptions } from '../utils/command-runner.js';
import {
  copyPreviewArtifacts,
  outputTail,
  type PreviewCheckEvidence,
  type PreviewCheckResult,
  type PreviewCheckStatus,
  writePreviewEvidence,
} from './preview-evidence.js';
import { findPreviewUrl, type PreviewGitHub } from './preview-source.js';
import { maskUrl, previewHostBlock } from './preview-url-guard.js';
import { runVerificationCommand } from './run-command.js';

export type { PreviewCheckResult } from './preview-evidence.js';
export { PREVIEW_REWORK_INSTRUCTIONS, previewReworkSummary } from './preview-evidence.js';

export interface PreviewCheckInput {
  config: PreviewConfig;
  github: PreviewGitHub;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  worktree: string;
  env?: Record<string, string>;
  logsDir?: string;
  onPgid?: (pgid: number) => void;
}

export interface PreviewCheckDeps {
  probe: (url: string) => Promise<number | null>;
  resolveHost: (hostname: string) => Promise<string[]>;
  runCommand: (argv: readonly string[], options: RunCommandOptions) => Promise<CommandResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

type PreviewWait = { ready: true; url: string } | { ready: false; reason: string; url?: string };

const POLL_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 5000;

const defaultProbe: PreviewCheckDeps['probe'] = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
    return res.status;
  } catch {
    return null;
  }
};

const DEFAULT_DEPS: PreviewCheckDeps = {
  probe: defaultProbe,
  resolveHost: async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address),
  runCommand: runVerificationCommand,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

const describeSource = (source: PreviewConfig['source']): string =>
  source.kind === 'deployment' ? `deployment environment ${source.environment}` : `PR comment ${source.urlPattern}`;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function waitForPreview(input: PreviewCheckInput, d: PreviewCheckDeps, deadline: number): Promise<PreviewWait> {
  const { config, headSha } = input;
  const target = { owner: input.owner, repo: input.repo, prNumber: input.prNumber, headSha };
  let url: string | null = null;
  let reason = `no preview URL found for ${headSha.slice(0, 12)} (${describeSource(config.source)})`;
  for (;;) {
    try {
      url = await findPreviewUrl(input.github, target, config.source);
      if (url) {
        const blocked = await previewHostBlock(url, d.resolveHost);
        if (blocked) return { ready: false, reason: blocked, url };
        const probeUrl = new URL(config.readyPath, url);
        const { origin } = new URL(url);
        if (probeUrl.origin !== origin)
          return { ready: false, reason: `readyPath leaves the preview origin ${origin}`, url };
        const status = await d.probe(probeUrl.toString());
        if (status === config.expectedStatus) return { ready: true, url };
        reason = `preview ${maskUrl(url)} not ready (last status ${status ?? 'no response'}) after ${config.readyTimeoutSeconds}s`;
      }
    } catch (err) {
      reason = `preview lookup failed: ${errorMessage(err)}`;
    }
    if (d.now() >= deadline) return { ready: false, reason, ...(url ? { url } : {}) };
    await d.sleep(POLL_INTERVAL_MS);
  }
}

export async function runPreviewCheck(
  input: PreviewCheckInput,
  deps: Partial<PreviewCheckDeps> = {},
): Promise<PreviewCheckResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const { config, headSha, worktree } = input;
  const started = d.now();
  const finish = (
    status: PreviewCheckStatus,
    url: string | undefined,
    fields: Partial<PreviewCheckEvidence> & Pick<PreviewCheckEvidence, 'readyWaitMs'>,
  ): PreviewCheckResult =>
    writePreviewEvidence(
      {
        status,
        evidence: {
          ...(url ? { url: maskUrl(url) } : {}),
          headSha,
          command: config.command,
          durationMs: d.now() - started,
          artifacts: [],
          ...fields,
        },
      },
      input.logsDir,
    );

  const wait = await waitForPreview(input, d, started + config.readyTimeoutSeconds * 1000);
  const readyWaitMs = d.now() - started;
  if (!wait.ready) return finish('preview-unavailable', wait.url, { readyWaitMs, reason: wait.reason });

  const r = await d.runCommand(config.command, {
    cwd: worktree,
    env: { ...input.env, [config.urlEnv]: wait.url },
    ...(input.onPgid ? { onPgid: input.onPgid } : {}),
    timeoutMs: config.commandTimeoutSeconds * 1000,
  });
  return finish(r.ok ? 'pass' : 'fail', wait.url, {
    readyWaitMs,
    commandMs: d.now() - started - readyWaitMs,
    exitCode: r.exitCode,
    outputTail: outputTail(r.stdout, r.stderr),
    ...copyPreviewArtifacts(worktree, config.artifacts, input.logsDir),
    ...(r.timedOut ? { reason: `preview command timed out after ${config.commandTimeoutSeconds}s` } : {}),
  });
}
