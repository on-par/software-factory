import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';

import { z } from 'zod';

import type { VisualProofStep } from '../config/visual-proof-section.js';
import type { VisualProofCapture, VisualProofRoute } from './visual-proof.js';

const MIN_PNG_BYTES = 2048;
const MAX_PNG_BYTES = 5 * 1024 * 1024;
export const MAX_CLIP_BYTES = 10 * 1024 * 1024;
const MAX_INFLATED_BYTES = 128 * 1024 * 1024;
const BLANK_DISTINCT_BYTES = 8;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_CHUNK_OVERHEAD = 12;

export const pathPart = (route: string): string => route.split(/[?#]/)[0] ?? route;

export function describeVisualProofStep(step: VisualProofStep): string {
  if ('goto' in step) return `goto ${step.goto}`;
  if ('click' in step) return `click ${JSON.stringify(step.click)}`;
  if ('fill' in step) return `fill ${JSON.stringify(step.fill)} with ${JSON.stringify(step.value)}`;
  if ('press' in step) return `press ${step.press}`;
  return `waitFor ${JSON.stringify(step.waitFor)}`;
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

function readPngChunks(bytes: Buffer): { header?: PngHeader; idat: Buffer[] } {
  const idat: Buffer[] = [];
  let header: PngHeader | undefined;
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length < length) throw new Error('truncated chunk');
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        interlace: data.readUInt8(12),
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += PNG_CHUNK_OVERHEAD + length;
  }
  return { ...(header ? { header } : {}), idat };
}

export function isBlankPng(bytes: Buffer): boolean | 'undecodable' {
  try {
    const { header, idat } = readPngChunks(bytes);
    const channels = header ? PNG_CHANNELS[header.colorType] : undefined;
    if (!header || idat.length === 0 || channels === undefined) return 'undecodable';
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_INFLATED_BYTES });
    const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
    const seen = new Set<number>();
    for (const [i, value] of raw.entries()) {
      if (header.interlace === 0 && i % (rowBytes + 1) === 0) continue;
      seen.add(value);
    }
    return seen.size < BLANK_DISTINCT_BYTES;
  } catch {
    return 'undecodable';
  }
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
type FileResult = { bytes: Buffer } | { diagnostic: string };

const insideOutDir = (outDir: string, file: string): string | undefined => {
  const full = resolve(outDir, file);
  return isAbsolute(file) || file.split(/[\\/]/).includes('..') || !full.startsWith(outDir + sep) ? undefined : full;
};

const lastGotoPath = (steps: readonly VisualProofStep[] | undefined): string | undefined => {
  for (const step of [...(steps ?? [])].reverse()) if ('goto' in step) return step.goto;
  return undefined;
};

const clipMatches = (format: 'gif' | 'webm' | 'mp4', bytes: Buffer): boolean => {
  if (format === 'gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6));
  if (format === 'webm') return bytes.subarray(0, 4).equals(WEBM_MAGIC);
  return bytes.toString('latin1', 4, 8) === 'ftyp';
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
  const outDir = resolve(expected.outDir);
  const fail = (diagnostic: string): ManifestResult => ({ ok: false, diagnostic });
  const checkImage = (label: string, file: string): FileResult => {
    const full = insideOutDir(outDir, file);
    if (!full) return { diagnostic: `${label} image path ${file} is outside the capture directory` };
    let bytes: Buffer;
    try {
      bytes = readFile(full);
    } catch {
      return { diagnostic: `${label} image ${file} could not be read` };
    }
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return { diagnostic: `${label} image ${file} is not a PNG` };
    }
    if (bytes.length < MIN_PNG_BYTES) return { diagnostic: `${label} blank or empty image (${bytes.length} bytes)` };
    if (bytes.length > MAX_PNG_BYTES) return { diagnostic: `${label} image exceeds 5 MiB (${bytes.length} bytes)` };
    const blank = isBlankPng(bytes);
    if (blank === 'undecodable') return { diagnostic: `${label} image ${file} is not a decodable PNG` };
    if (blank) return { diagnostic: `${label} blank image ${file} (uniform colour)` };
    return { bytes };
  };

  const failure = manifest.failures?.find((f) =>
    expected.routes.some((r) => r.route === f.route && r.state === f.state),
  );
  if (failure) {
    const route = expected.routes.find((r) => r.route === failure.route && r.state === failure.state);
    const step = route?.steps?.[failure.step - 1];
    return fail(
      `${failure.route} (state ${failure.state}) step ${failure.step} ${step ? describeVisualProofStep(step) : '?'} failed: ${failure.message}`,
    );
  }

  const captures: VisualProofCapture[] = [];
  for (const cap of manifest.captures) {
    const route = expected.routes.find((r) => r.route === cap.route && r.state === cap.state);
    if (!route) return fail(`capture for unconfigured route ${cap.route} (state ${cap.state})`);
    if (!route.steps && (cap.before || cap.clip)) {
      return fail(`${cap.route} unexpected before/clip for a route without steps`);
    }
    const expectedPath = pathPart(lastGotoPath(route.steps) ?? route.route);
    if (pathPart(cap.finalPath) !== expectedPath) {
      return fail(`${cap.route} landed on ${cap.finalPath}, expected ${expectedPath} — login redirect or wrong page`);
    }
    if (!cap.assertion.passed || cap.assertion.target !== route.assert) {
      return fail(`${cap.route} positive assertion "${route.assert}" did not pass`);
    }
    if (cap.viewport.width !== route.viewport.width || cap.viewport.height !== route.viewport.height) {
      return fail(
        `${cap.route} captured at ${cap.viewport.width}x${cap.viewport.height}, expected ${route.viewport.width}x${route.viewport.height}`,
      );
    }
    const after = checkImage(cap.route, cap.file);
    if ('diagnostic' in after) return fail(after.diagnostic);
    const captured: VisualProofCapture = {
      route: cap.route,
      state: cap.state,
      viewport: cap.viewport,
      finalPath: cap.finalPath,
      file: cap.file,
      bytes: after.bytes.length,
    };
    if (route.steps) {
      const label = `${cap.route} (state ${cap.state})`;
      if (!cap.before) return fail(`${label} has no before capture`);
      if (pathPart(cap.before.finalPath) !== pathPart(route.route)) {
        return fail(
          `${label} before capture landed on ${cap.before.finalPath}, expected ${pathPart(route.route)} — login redirect or wrong page`,
        );
      }
      const before = checkImage(cap.route, cap.before.file);
      if ('diagnostic' in before) return fail(before.diagnostic);
      if (before.bytes.equals(after.bytes)) {
        return fail(`${label} after capture is identical to before — steps had no visible effect`);
      }
      if (JSON.stringify(cap.steps) !== JSON.stringify(route.steps)) {
        return fail(`${label} steps do not match the configured steps`);
      }
      captured.before = { file: cap.before.file, finalPath: cap.before.finalPath, bytes: before.bytes.length };
      captured.steps = route.steps;
      if (route.record) {
        const clip = cap.clip;
        const kind = route.record === 'gif' ? 'gif' : 'video';
        if (!clip) return fail(`${cap.route} clip missing`);
        if ((clip.format === 'gif') !== (route.record === 'gif')) return fail(`${cap.route} clip is not a ${kind}`);
        const full = insideOutDir(outDir, clip.file);
        if (!full) return fail(`${cap.route} clip path ${clip.file} is outside the capture directory`);
        let clipBytes: Buffer;
        try {
          clipBytes = readFile(full);
        } catch {
          return fail(`${cap.route} clip ${clip.file} could not be read`);
        }
        if (!clipMatches(clip.format, clipBytes)) return fail(`${cap.route} clip is not a ${kind}`);
        if (clipBytes.length > MAX_CLIP_BYTES) return fail(`${cap.route} clip exceeds 10 MiB`);
        captured.clip = { file: clip.file, format: clip.format, bytes: clipBytes.length };
      }
    }
    captures.push(captured);
  }
  const missing = expected.routes.filter((r) => !captures.some((c) => c.route === r.route && c.state === r.state));
  if (missing.length > 0) {
    return fail(`no capture for selected route ${missing.map((r) => r.route).join(', ')}`);
  }
  return { ok: true, captures };
}
