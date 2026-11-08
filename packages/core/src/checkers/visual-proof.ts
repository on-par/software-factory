// src/checkers/visual-proof.ts — SHIP UI visual proof: classify, capture through the repo's tooling and validate (#2232)

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { QaConfig } from '../config/qa-section.js';
import type { VisualProofConfig } from '../config/visual-proof-section.js';
import { checkerParentEnv } from '../environment/checker-env.js';
import { killProcessGroup } from '../environment/process-groups.js';
import type { CommandResult } from '../utils/command-runner.js';
import { childProcessEnv } from '../utils/github-credentials.js';
import { defaultStartApp, type AppSmokeDeps } from './app-smoke.js';
import { stripAnsi } from './command-log.js';
import { runVerificationCommand, VERIFICATION_SCRUBBED_ENV_VARS } from './run-command.js';

export interface VisualProofRoute {
  route: string;
  state: string;
  assert: string;
  viewport: { width: number; height: number };
}

export interface VisualProofCapture {
  route: string;
  state: string;
  viewport: { width: number; height: number };
  finalPath: string;
  /** Path of the PNG relative to the capture out dir. */
  file: string;
  bytes: number;
}

export type VisualProofRequirement =
  { required: false } | { required: true; routes: VisualProofRoute[]; diagnostic?: string };

export interface VisualProofImage {
  route: string;
  state: string;
  viewport: { width: number; height: number };
  url: string;
}

export interface VisualProofResult {
  status: 'pass' | 'fail' | 'unavailable' | 'not-required';
  headSha: string;
  runId: string;
  captures: VisualProofCapture[];
  images?: VisualProofImage[];
  /** Local capture directory of a pass; read by the evidence upload, never rendered. */
  outDir?: string;
  diagnostic?: string;
}

const MIN_PNG_BYTES = 2048;
const MAX_PNG_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

const pathPart = (route: string): string => route.split(/[?#]/)[0] ?? route;

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
  if (uncovered.length > 0) diagnostics.push(`UI files not covered by any visualProof route: ${uncovered.join(', ')}`);

  const routes = selected
    .slice(0, config.maxCaptures)
    .map(({ route, state, assert, viewport }) => ({ route, state, assert, viewport }));
  return {
    required: true,
    routes,
    ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join('; ') } : {}),
  };
}

const ManifestSchema = z
  .object({
    headSha: z.string(),
    runId: z.string(),
    captures: z.array(
      z
        .object({
          route: z.string(),
          state: z.string(),
          viewport: z.object({ width: z.number(), height: z.number() }).strict(),
          finalPath: z.string(),
          assertion: z.object({ target: z.string(), passed: z.boolean() }).strict(),
          file: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

type ManifestResult = { ok: true; captures: VisualProofCapture[] } | { ok: false; diagnostic: string };

export function validateVisualProofManifest(
  raw: unknown,
  expected: { headSha: string; runId: string; outDir: string; routes: readonly VisualProofRoute[] },
  readFile: (path: string) => Buffer = readFileSync,
): ManifestResult {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      diagnostic: `invalid capture manifest: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    };
  }
  const manifest = parsed.data;
  if (manifest.headSha !== expected.headSha || manifest.runId !== expected.runId) {
    return { ok: false, diagnostic: 'capture is for another head/run' };
  }
  const outDir = resolve(expected.outDir);
  const captures: VisualProofCapture[] = [];
  for (const cap of manifest.captures) {
    const route = expected.routes.find((r) => r.route === cap.route && r.state === cap.state);
    if (!route) return { ok: false, diagnostic: `capture for unconfigured route ${cap.route} (state ${cap.state})` };
    if (pathPart(cap.finalPath) !== pathPart(route.route)) {
      return {
        ok: false,
        diagnostic: `${cap.route} landed on ${cap.finalPath}, expected ${pathPart(route.route)} — login redirect or wrong page`,
      };
    }
    if (!cap.assertion.passed || cap.assertion.target !== route.assert) {
      return { ok: false, diagnostic: `${cap.route} positive assertion "${route.assert}" did not pass` };
    }
    if (cap.viewport.width !== route.viewport.width || cap.viewport.height !== route.viewport.height) {
      return {
        ok: false,
        diagnostic: `${cap.route} captured at ${cap.viewport.width}x${cap.viewport.height}, expected ${route.viewport.width}x${route.viewport.height}`,
      };
    }
    const full = resolve(outDir, cap.file);
    if (isAbsolute(cap.file) || cap.file.split(/[\\/]/).includes('..') || !full.startsWith(outDir + sep)) {
      return { ok: false, diagnostic: `${cap.route} image path ${cap.file} is outside the capture directory` };
    }
    let bytes: Buffer;
    try {
      bytes = readFile(full);
    } catch {
      return { ok: false, diagnostic: `${cap.route} image ${cap.file} could not be read` };
    }
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return { ok: false, diagnostic: `${cap.route} image ${cap.file} is not a PNG` };
    }
    if (bytes.length < MIN_PNG_BYTES)
      return { ok: false, diagnostic: `${cap.route} blank or empty image (${bytes.length} bytes)` };
    if (bytes.length > MAX_PNG_BYTES)
      return { ok: false, diagnostic: `${cap.route} image exceeds 5 MiB (${bytes.length} bytes)` };
    captures.push({
      route: cap.route,
      state: cap.state,
      viewport: cap.viewport,
      finalPath: cap.finalPath,
      file: cap.file,
      bytes: bytes.length,
    });
  }
  const missing = expected.routes.filter((r) => !captures.some((c) => c.route === r.route && c.state === r.state));
  if (missing.length > 0) {
    return { ok: false, diagnostic: `no capture for selected route ${missing.map((r) => r.route).join(', ')}` };
  }
  return { ok: true, captures };
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

  let startPgid: number | undefined;
  const app = startApp(qa.start, {
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

    const outDir = join(input.logsDir ?? join(tmpdir(), `factory-${runId}`), 'visual-proof', headSha.slice(0, 12));
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const r = await runCommand(config.command, {
      cwd: worktree,
      env: {
        ...env,
        VISUAL_PROOF_BASE_URL: baseUrl,
        VISUAL_PROOF_OUT_DIR: outDir,
        VISUAL_PROOF_ROUTES: JSON.stringify(requirement.routes),
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
}
