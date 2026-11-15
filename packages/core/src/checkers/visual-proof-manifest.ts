import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { VisualProofStep } from '../config/visual-proof-section.js';
import { isBlankPng } from './visual-proof-png.js';
import type { VisualProofCapture, VisualProofRoute } from './visual-proof.js';

export const MAX_CLIP_BYTES = 10 * 1024 * 1024;
const MIN_PNG_BYTES = 2048;
const MAX_PNG_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const MP4_BRAND_OFFSET = 4;

const pathPart = (route: string): string => route.split(/[?#]/)[0] ?? route;

export function describeVisualProofStep(step: VisualProofStep): string {
  if ('goto' in step) return `goto ${step.goto}`;
  if ('click' in step) return `click "${step.click}"`;
  if ('fill' in step) return `fill "${step.fill}" with "${step.value}"`;
  if ('press' in step) return `press ${step.press}`;
  return `waitFor "${step.waitFor}"`;
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
          before: z.object({ file: z.string(), finalPath: z.string() }).strict().optional(),
          steps: z.array(z.unknown()).optional(),
          clip: z
            .object({ file: z.string(), format: z.enum(['gif', 'webm', 'mp4']) })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    failures: z
      .array(
        z.object({ route: z.string(), state: z.string(), step: z.number().int().min(1), message: z.string() }).strict(),
      )
      .optional(),
  })
  .strict();

type ManifestResult = { ok: true; captures: VisualProofCapture[] } | { ok: false; diagnostic: string };
type Checked<T> = { ok: true; value: T } | { ok: false; diagnostic: string };

const clipMatchesFormat = (bytes: Buffer, format: 'gif' | 'webm' | 'mp4', wanted: 'gif' | 'video'): boolean => {
  if (wanted === 'gif') {
    const magic = bytes.toString('latin1', 0, 6);
    return format === 'gif' && (magic === 'GIF87a' || magic === 'GIF89a');
  }
  if (format === 'webm') return bytes.subarray(0, WEBM_MAGIC.length).equals(WEBM_MAGIC);
  return format === 'mp4' && bytes.toString('latin1', MP4_BRAND_OFFSET, MP4_BRAND_OFFSET + 4) === 'ftyp';
};

const stepsMatch = (echoed: readonly unknown[] | undefined, configured: readonly VisualProofStep[]): boolean =>
  echoed !== undefined && JSON.stringify(echoed) === JSON.stringify(configured);

const finalPathFor = (route: VisualProofRoute): string => {
  const gotos = (route.steps ?? []).flatMap((s) => ('goto' in s ? [s.goto] : []));
  return pathPart(gotos[gotos.length - 1] ?? route.route);
};

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
  for (const failure of manifest.failures ?? []) {
    const failed = expected.routes.find((r) => r.route === failure.route && r.state === failure.state);
    if (!failed) continue;
    const step = failed.steps?.[failure.step - 1];
    return {
      ok: false,
      diagnostic: `${failed.route} (state ${failed.state}) step ${failure.step} ${step ? describeVisualProofStep(step) : '?'} failed: ${failure.message}`,
    };
  }
  const outDir = resolve(expected.outDir);
  const contain = (label: string, file: string): Checked<string> => {
    const full = resolve(outDir, file);
    if (isAbsolute(file) || file.split(/[\\/]/).includes('..') || !full.startsWith(outDir + sep)) {
      return { ok: false, diagnostic: `${label} image path ${file} is outside the capture directory` };
    }
    return { ok: true, value: full };
  };
  const checkImage = (label: string, file: string): Checked<Buffer> => {
    const full = contain(label, file);
    if (!full.ok) return full;
    let bytes: Buffer;
    try {
      bytes = readFile(full.value);
    } catch {
      return { ok: false, diagnostic: `${label} image ${file} could not be read` };
    }
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return { ok: false, diagnostic: `${label} image ${file} is not a PNG` };
    }
    if (bytes.length < MIN_PNG_BYTES)
      return { ok: false, diagnostic: `${label} blank or empty image (${bytes.length} bytes)` };
    if (bytes.length > MAX_PNG_BYTES)
      return { ok: false, diagnostic: `${label} image exceeds 5 MiB (${bytes.length} bytes)` };
    const blank = isBlankPng(bytes);
    if (blank === 'undecodable') return { ok: false, diagnostic: `${label} image ${file} is not a decodable PNG` };
    if (blank) return { ok: false, diagnostic: `${label} blank image ${file} (uniform colour)` };
    return { ok: true, value: bytes };
  };
  const checkClip = (
    label: string,
    wanted: 'gif' | 'video',
    clip: { file: string; format: 'gif' | 'webm' | 'mp4' } | undefined,
  ): Checked<number> => {
    if (!clip) return { ok: false, diagnostic: `${label} clip missing` };
    const full = contain(label, clip.file);
    if (!full.ok) return full;
    let bytes: Buffer;
    try {
      bytes = readFile(full.value);
    } catch {
      return { ok: false, diagnostic: `${label} clip missing` };
    }
    if (!clipMatchesFormat(bytes, clip.format, wanted)) {
      return { ok: false, diagnostic: `${label} clip is not a ${wanted}` };
    }
    if (bytes.length > MAX_CLIP_BYTES) return { ok: false, diagnostic: `${label} clip exceeds 10 MiB` };
    return { ok: true, value: bytes.length };
  };

  const captures: VisualProofCapture[] = [];
  for (const cap of manifest.captures) {
    const route = expected.routes.find((r) => r.route === cap.route && r.state === cap.state);
    if (!route) return { ok: false, diagnostic: `capture for unconfigured route ${cap.route} (state ${cap.state})` };
    const stateLabel = `${cap.route} (state ${cap.state})`;
    const steps = route.steps;
    if (!steps && (cap.before || cap.clip)) {
      return { ok: false, diagnostic: `${cap.route} unexpected before/clip for a route without steps` };
    }
    if (pathPart(cap.finalPath) !== finalPathFor(route)) {
      return {
        ok: false,
        diagnostic: `${cap.route} landed on ${cap.finalPath}, expected ${finalPathFor(route)} — login redirect or wrong page`,
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
    const after = checkImage(cap.route, cap.file);
    if (!after.ok) return after;
    const entry: VisualProofCapture = {
      route: cap.route,
      state: cap.state,
      viewport: cap.viewport,
      finalPath: cap.finalPath,
      file: cap.file,
      bytes: after.value.length,
    };
    if (steps) {
      if (!cap.before) return { ok: false, diagnostic: `${stateLabel} has no before capture` };
      if (pathPart(cap.before.finalPath) !== pathPart(route.route)) {
        return {
          ok: false,
          diagnostic: `${cap.route} before capture landed on ${cap.before.finalPath}, expected ${pathPart(route.route)}`,
        };
      }
      const before = checkImage(cap.route, cap.before.file);
      if (!before.ok) return before;
      if (before.value.equals(after.value)) {
        return {
          ok: false,
          diagnostic: `${stateLabel} after capture is identical to before — steps had no visible effect`,
        };
      }
      if (!stepsMatch(cap.steps, steps)) {
        return { ok: false, diagnostic: `${stateLabel} steps do not match the configured steps` };
      }
      entry.before = { file: cap.before.file, finalPath: cap.before.finalPath, bytes: before.value.length };
      entry.steps = steps;
      if (route.record) {
        const clip = checkClip(stateLabel, route.record, cap.clip);
        if (!clip.ok) return clip;
        if (cap.clip) entry.clip = { file: cap.clip.file, format: cap.clip.format, bytes: clip.value };
      }
    }
    captures.push(entry);
  }
  const missing = expected.routes.filter((r) => !captures.some((c) => c.route === r.route && c.state === r.state));
  if (missing.length > 0) {
    return { ok: false, diagnostic: `no capture for selected route ${missing.map((r) => r.route).join(', ')}` };
  }
  return { ok: true, captures };
}
