import type { PreviewConfig } from '../config/preview-section.js';
import { type PinnedAddress, vetPreviewHost } from './preview-pin.js';
import { findPreviewUrl, type PreviewGitHub, type PreviewTarget } from './preview-source.js';
import { maskUrl } from './preview-url-guard.js';

export interface PreviewPollDeps {
  probe: (url: string, pin: PinnedAddress) => Promise<number | null>;
  resolveHost: (hostname: string) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface PreviewWaitInput {
  config: PreviewConfig;
  github: PreviewGitHub;
  target: PreviewTarget;
}

type PreviewWait = { ready: true; url: string } | { ready: false; reason: string; url?: string };
type PollOutcome = { done: PreviewWait } | { reason: string };

const POLL_INTERVAL_MS = 5000;

const describeSource = (source: PreviewConfig['source']): string =>
  source.kind === 'deployment' ? `deployment environment ${source.environment}` : `PR comment ${source.urlPattern}`;

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function pollOnce(url: string, config: PreviewConfig, d: PreviewPollDeps): Promise<PollOutcome> {
  const vet = await vetPreviewHost(url, d.resolveHost);
  if (!vet.ok) return { done: { ready: false, reason: vet.reason, url } };
  const probeUrl = new URL(config.readyPath, url);
  const { origin } = new URL(url);
  if (probeUrl.origin !== origin) {
    return { done: { ready: false, reason: `readyPath leaves the preview origin ${origin}`, url } };
  }
  const status = await d.probe(probeUrl.toString(), vet.pin);
  if (status === config.expectedStatus) return { done: { ready: true, url } };
  const last = status ?? 'no response';
  return { reason: `preview ${maskUrl(url)} not ready (last status ${last}) after ${config.readyTimeoutSeconds}s` };
}

export async function waitForPreview(
  { config, github, target }: PreviewWaitInput,
  d: PreviewPollDeps,
  deadline: number,
): Promise<PreviewWait> {
  let url: string | null = null;
  let reason = `no preview URL found for ${target.headSha.slice(0, 12)} (${describeSource(config.source)})`;
  for (;;) {
    try {
      url = await findPreviewUrl(github, target, config.source);
      if (url) {
        const outcome = await pollOnce(url, config, d);
        if ('done' in outcome) return outcome.done;
        reason = outcome.reason;
      }
    } catch (err) {
      reason = `preview lookup failed: ${errorMessage(err)}`;
    }
    if (d.now() >= deadline) return { ready: false, reason, ...(url ? { url } : {}) };
    await d.sleep(POLL_INTERVAL_MS);
  }
}
