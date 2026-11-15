import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { QaConfig } from '../config/qa-section.js';
import type { VisualProofConfig, VisualProofStep } from '../config/visual-proof-section.js';
import { checkerParentEnv } from '../environment/checker-env.js';
import { killProcessGroup } from '../environment/process-groups.js';
import type { CommandResult } from '../utils/command-runner.js';
import { childProcessEnv } from '../utils/github-credentials.js';
import { defaultStartApp, type AppSmokeDeps } from './app-smoke.js';
import { stripAnsi } from './command-log.js';
import { runVerificationCommand, VERIFICATION_SCRUBBED_ENV_VARS } from './run-command.js';
import { MAX_CLIP_BYTES, validateVisualProofManifest } from './visual-proof-manifest.js';

export interface VisualProofRoute {
  route: string;
  state: string;
  assert: string;
  viewport: { width: number; height: number };
  steps?: VisualProofStep[];
  record?: 'gif' | 'video';
}

export interface VisualProofCapture {
  route: string;
  state: string;
  viewport: { width: number; height: number };
  finalPath: string;
  file: string;
  bytes: number;
  before?: { file: string; finalPath: string; bytes: number };
  steps?: VisualProofStep[];
  clip?: { file: string; format: 'gif' | 'webm' | 'mp4'; bytes: number };
}

export type VisualProofRequirement =
  { required: false } | { required: true; routes: VisualProofRoute[]; diagnostic?: string; uncovered?: string[] };

export interface VisualProofImage {
  route: string;
  state: string;
  viewport: { width: number; height: number };
  url: string;
  beforeUrl?: string;
  clipUrl?: string;
  clipFormat?: 'gif' | 'webm' | 'mp4';
  steps?: VisualProofStep[];
}

export interface VisualProofResult {
  status: 'pass' | 'fail' | 'unavailable' | 'not-required';
  headSha: string;
  runId: string;
  captures: VisualProofCapture[];
  images?: VisualProofImage[];
  outDir?: string;
  diagnostic?: string;
  attempts?: number;
  uncovered?: string[];
}

const TAIL_CHARS = 2000;
const POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 2000;
const KILL_GRACE_MS = 2000;

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split('**/')
      .map((part) =>
        part
          .split('**')
          .map((seg) =>
            seg
              .split('*')
              .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
              .join('[^/]*'),
          )
          .join('.*'),
      )
      .join('(?:.*/)?')}$`,
  );

const matchesAny = (globs: readonly string[], file: string): boolean => globs.some((g) => globToRegExp(g).test(file));

export function classifyVisualProof(input: {
  changedFiles: readonly string[];
  config: VisualProofConfig | undefined;
  planRoutes: readonly string[];
}): VisualProofRequirement {
  const { changedFiles, config, planRoutes } = input;
  if (!config) {
    if (planRoutes.length === 0) return { required: false };
    return {
      required: true,
      routes: [],
      diagnostic: `visual proof required by the plan's screenshot entries (${planRoutes.join(', ')}) but .factory config has no visualProof section — add visualProof.uiPaths, routes and command`,
    };
  }
  const uiFiles = changedFiles.filter((f) => matchesAny(config.uiPaths, f));
  if (uiFiles.length === 0 && planRoutes.length === 0) return { required: false };

  const diagnostics: string[] = [];
  const selected = config.routes.filter(
    (r) => uiFiles.some((f) => matchesAny(r.paths, f)) || planRoutes.includes(r.route),
  );
  for (const planRoute of planRoutes) {
    if (!config.routes.some((r) => r.route === planRoute)) {
      diagnostics.push(`plan screenshot route ${planRoute} is not in visualProof.routes`);
    }
  }
  const uncovered = uiFiles.filter((f) => !selected.some((r) => matchesAny(r.paths, f)));

  const routes = selected.slice(0, config.maxCaptures).map(({ route, state, assert, viewport, steps, record }) => ({
    route,
    state,
    assert,
    viewport,
    ...(steps ? { steps } : {}),
    ...(record ? { record } : {}),
  }));
  return {
    required: true,
    routes,
    ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join('; ') } : {}),
    ...(uncovered.length > 0 ? { uncovered } : {}),
  };
}

export interface VisualProofCaptureInput {
  requirement: VisualProofRequirement;
  qa: QaConfig | null;
  config: VisualProofConfig;
  port?: number;
  headSha: string;
  runId: string;
  worktree: string;
  logsDir?: string;
  onPgid?: (pgid: number) => void;
  mode?: 'required' | 'advisory';
  log?: (message: string) => void;
}

export interface VisualProofCaptureDeps {
  startApp: AppSmokeDeps['startApp'];
  probeReady: AppSmokeDeps['probeReady'];
  runCommand: (
    argv: readonly string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onPgid?: (pgid: number) => void },
  ) => Promise<CommandResult>;
  killGroup: AppSmokeDeps['killGroup'];
  sleep: AppSmokeDeps['sleep'];
  now: AppSmokeDeps['now'];
  readFile: (path: string) => Buffer;
}

const defaultProbeReady: VisualProofCaptureDeps['probeReady'] = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
    return res.status;
  } catch {
    return null;
  }
};

const DEFAULT_DEPS: VisualProofCaptureDeps = {
  startApp: defaultStartApp,
  probeReady: defaultProbeReady,
  runCommand: runVerificationCommand,
  killGroup: (pgid) => killProcessGroup(pgid, { graceMs: KILL_GRACE_MS }),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now: Date.now,
  readFile: readFileSync,
};

const tail = (text: string): string => stripAnsi(text.trim()).trim().slice(-TAIL_CHARS);

export async function runVisualProofCapture(
  input: VisualProofCaptureInput,
  deps: Partial<VisualProofCaptureDeps> = {},
): Promise<VisualProofResult> {
  const { requirement, qa, config, port, headSha, runId, worktree } = input;
  const base = { headSha, runId, captures: [] as VisualProofCapture[] };
  const done = (status: VisualProofResult['status'], diagnostic?: string): VisualProofResult => ({
    status,
    ...base,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
  if (!requirement.required) return done('not-required');
  if (requirement.diagnostic) return done('fail', requirement.diagnostic);
  if (!qa?.start?.length) return done('unavailable', "qa.start missing — visual proof needs the repo's start command");
  if (port === undefined || !Number.isInteger(port) || port <= 0) {
    return done('unavailable', 'no leased lane port — enable environment.ports');
  }
  const uncovered = requirement.uncovered?.length ? requirement.uncovered : undefined;
  if (uncovered && ((input.mode ?? 'required') === 'required' || requirement.routes.length === 0)) {
    return done('fail', `UI files not covered by any visualProof route: ${uncovered.join(', ')}`);
  }

  const { startApp, probeReady, runCommand, killGroup, sleep, now, readFile } = { ...DEFAULT_DEPS, ...deps };
  const baseUrl = `http://127.0.0.1:${port}`;
  const laneEnv = { PORT: String(port), FACTORY_APP_PORT: String(port), FACTORY_BASE_URL: baseUrl };
  const env = {
    ...childProcessEnv(checkerParentEnv(process.env), laneEnv),
    ...Object.fromEntries(VERIFICATION_SCRUBBED_ENV_VARS.map((name) => [name, undefined])),
    HOST: '127.0.0.1',
  };
  const readyUrl = `${baseUrl}${qa.readyPath ?? '/'}`;
  const readyTimeoutSeconds = qa.readyTimeoutSeconds ?? 60;

  const attemptOnce = async (attempt: number): Promise<VisualProofResult> => {
    let startPgid: number | undefined;
    const app = startApp(qa.start ?? [], {
      cwd: worktree,
      env,
      onPgid: (pgid) => {
        startPgid = pgid;
        input.onPgid?.(pgid);
      },
    });
    const state: { exit?: { code: number | null; signal: NodeJS.Signals | null } } = {};
    void app.exited.then((e) => {
      state.exit = e;
    });
    const startFail = (reason: string): VisualProofResult => {
      const out = tail(app.output());
      return done('unavailable', `${reason}${out ? `: ${out}` : ''}`);
    };
    const exitedReason = (): string => `start exited (code ${state.exit?.code ?? state.exit?.signal}) before ready`;

    try {
      const deadline = now() + readyTimeoutSeconds * 1000;
      let ready = false;
      while (now() < deadline) {
        if (state.exit) return startFail(exitedReason());
        const status = await probeReady(readyUrl);
        if (status !== null && status < 500) {
          ready = true;
          break;
        }
        if (state.exit) return startFail(exitedReason());
        await sleep(POLL_INTERVAL_MS);
      }
      if (!ready) return startFail(`app not ready after ${readyTimeoutSeconds}s on ${readyUrl}`);

      const outDir = join(
        input.logsDir ?? join(tmpdir(), `factory-${runId}`),
        'visual-proof',
        headSha.slice(0, 12),
        `attempt-${attempt}`,
      );
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const r = await runCommand(config.command, {
        cwd: worktree,
        env: {
          ...env,
          VISUAL_PROOF_BASE_URL: baseUrl,
          VISUAL_PROOF_OUT_DIR: outDir,
          VISUAL_PROOF_ROUTES: JSON.stringify(requirement.routes),
          VISUAL_PROOF_MAX_CLIP_BYTES: String(MAX_CLIP_BYTES),
          FACTORY_HEAD_SHA: headSha,
          FACTORY_RUN_ID: runId,
        },
        onPgid: input.onPgid,
        timeoutMs: config.timeoutSeconds * 1000,
      });
      if (r.timedOut) return done('fail', `capture command timed out after ${config.timeoutSeconds}s`);
      if (!r.ok) {
        const out = tail(r.stderr.trim() !== '' ? r.stderr : r.stdout);
        return done('fail', `capture command exited ${r.exitCode}${out ? `: ${out}` : ''}`);
      }
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFile(join(outDir, 'manifest.json')).toString('utf8'));
      } catch {
        return done('fail', 'capture command wrote no readable manifest.json to VISUAL_PROOF_OUT_DIR');
      }
      const checked = validateVisualProofManifest(
        manifest,
        { headSha, runId, outDir, routes: requirement.routes },
        readFile,
      );
      if (!checked.ok) return done('fail', checked.diagnostic);
      return { status: 'pass', headSha, runId, captures: checked.captures, outDir };
    } finally {
      if (startPgid !== undefined) await killGroup(startPgid).catch(() => undefined);
    }
  };

  const max = config.captureAttempts ?? 3;
  const withCoverage = (result: VisualProofResult): VisualProofResult => ({
    ...result,
    ...(uncovered ? { uncovered } : {}),
  });
  let last = done('fail');
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await attemptOnce(attempt);
    if (result.status === 'pass') return withCoverage({ ...result, attempts: attempt });
    last = result;
    input.log?.(`visual proof capture attempt ${attempt}/${max} failed: ${result.diagnostic}`);
    if (attempt < max) await sleep(POLL_INTERVAL_MS);
  }
  return withCoverage({ ...last, diagnostic: `after ${max} attempts: ${last.diagnostic}`, attempts: max });
}
