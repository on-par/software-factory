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
import { probePinned, type PreviewHostVet, vetPreviewHost } from './preview-pin.js';
import type { PreviewGitHub } from './preview-source.js';
import { maskUrl } from './preview-url-guard.js';
import { errorMessage, type PreviewPollDeps, waitForPreview } from './preview-wait.js';
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

export interface PreviewCheckDeps extends PreviewPollDeps {
  runCommand: (argv: readonly string[], options: RunCommandOptions) => Promise<CommandResult>;
}

const DEFAULT_DEPS: PreviewCheckDeps = {
  probe: probePinned,
  resolveHost: async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address),
  runCommand: runVerificationCommand,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

const recheckHost = (url: string, d: PreviewCheckDeps): Promise<PreviewHostVet> =>
  vetPreviewHost(url, d.resolveHost).catch((err: unknown) => ({
    ok: false,
    reason: `preview host check failed: ${errorMessage(err)}`,
  }));

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

  const target = { owner: input.owner, repo: input.repo, prNumber: input.prNumber, headSha };
  const wait = await waitForPreview(
    { config, github: input.github, target },
    d,
    started + config.readyTimeoutSeconds * 1000,
  );
  const readyWaitMs = d.now() - started;
  if (!wait.ready) return finish('preview-unavailable', wait.url, { readyWaitMs, reason: wait.reason });
  const recheck = await recheckHost(wait.url, d);
  if (!recheck.ok) return finish('preview-unavailable', wait.url, { readyWaitMs, reason: recheck.reason });

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
