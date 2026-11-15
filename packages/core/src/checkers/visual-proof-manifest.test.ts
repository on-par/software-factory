import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { noisePng, solidPng } from '../test-support/visual-proof-fixtures.js';
import {
  describeVisualProofStep,
  isBlankPng,
  MAX_CLIP_BYTES,
  validateVisualProofManifest,
} from './visual-proof-manifest.js';
import type { VisualProofRoute } from './visual-proof.js';

const HEAD = 'a'.repeat(40);
const RUN = 'run-1';
const VIEWPORT = { width: 1280, height: 800 };

const route = (r: string, assert = 'Settings'): VisualProofRoute => ({
  route: r,
  state: 'default',
  assert,
  viewport: VIEWPORT,
});

describe('describeVisualProofStep', () => {
  it('renders every step kind', () => {
    expect(describeVisualProofStep({ goto: '/x' })).toBe('goto /x');
    expect(describeVisualProofStep({ click: '#sel' })).toBe('click "#sel"');
    expect(describeVisualProofStep({ fill: '#sel', value: 'v' })).toBe('fill "#sel" with "v"');
    expect(describeVisualProofStep({ press: 'Enter' })).toBe('press Enter');
    expect(describeVisualProofStep({ waitFor: 'text' })).toBe('waitFor "text"');
  });
});

describe('isBlankPng', () => {
  it('is false for a noisy image, true for a solid one and undecodable for garbage', () => {
    expect(isBlankPng(noisePng(4096))).toBe(false);
    expect(isBlankPng(solidPng())).toBe(true);
    expect(isBlankPng(Buffer.from('garbage that is not a png at all'))).toBe('undecodable');
    expect(isBlankPng(noisePng(100))).toBe('undecodable');
  });

  it('is undecodable when IHDR, IDAT or the inflated data is missing or the colour type is unknown', () => {
    const png = noisePng(4096);
    const signature = png.subarray(0, 8);
    const ihdrChunk = png.subarray(8, 8 + 25);
    expect(isBlankPng(Buffer.concat([signature, ihdrChunk]))).toBe('undecodable');
    const badColour = Buffer.from(png);
    badColour.writeUInt8(5, 8 + 8 + 9);
    expect(isBlankPng(badColour)).toBe('undecodable');
    const corrupt = Buffer.from(png);
    corrupt.fill(0xff, 8 + 25 + 8, 8 + 25 + 40);
    expect(isBlankPng(corrupt)).toBe('undecodable');
    const truncated = png.subarray(0, 8 + 25 + 20);
    expect(isBlankPng(truncated)).toBe('undecodable');
  });
});

describe('validateVisualProofManifest', () => {
  const outDir = resolve('/tmp/out');
  const png = (size = 4096): Buffer => noisePng(size);
  const capture = (patch: Record<string, unknown> = {}) => ({
    route: '/settings',
    state: 'default',
    viewport: VIEWPORT,
    finalPath: '/settings',
    assertion: { target: 'Settings', passed: true },
    file: '0.png',
    ...patch,
  });
  const manifest = (caps: Record<string, unknown>[] = [capture()], patch: Record<string, unknown> = {}) => ({
    headSha: HEAD,
    runId: RUN,
    captures: caps,
    ...patch,
  });
  const check = (raw: unknown, file: Buffer = png()) =>
    validateVisualProofManifest(raw, { headSha: HEAD, runId: RUN, outDir, routes: [route('/settings')] }, () => file);

  it('accepts a valid manifest', () => {
    const r = check(manifest());
    expect(r).toEqual({
      ok: true,
      captures: [
        {
          route: '/settings',
          state: 'default',
          viewport: VIEWPORT,
          finalPath: '/settings',
          file: '0.png',
          bytes: 4096,
        },
      ],
    });
  });

  it('rejects a manifest for another head or run', () => {
    expect(check(manifest([capture()], { headSha: 'b'.repeat(40) }))).toEqual({
      ok: false,
      diagnostic: 'capture is for another head/run',
    });
    expect(check(manifest([capture()], { runId: 'other' }))).toMatchObject({
      ok: false,
      diagnostic: 'capture is for another head/run',
    });
  });

  it('rejects a capture for an unconfigured route', () => {
    expect(check(manifest([capture({ route: '/admin' })]))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('unconfigured route /admin'),
    });
  });

  it('rejects a selected route without a capture', () => {
    expect(check(manifest([]))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('no capture for selected route /settings'),
    });
  });

  it('rejects a capture whose final path is a login redirect', () => {
    expect(check(manifest([capture({ finalPath: '/login' })]))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('landed on /login, expected /settings — login redirect or wrong page'),
    });
  });

  it('rejects a capture whose positive assertion did not pass', () => {
    expect(check(manifest([capture({ assertion: { target: 'Settings', passed: false } })]))).toMatchObject({
      ok: false,
    });
    expect(check(manifest([capture({ assertion: { target: 'Other', passed: true } })]))).toMatchObject({ ok: false });
  });

  it('rejects a viewport different from the configured one', () => {
    expect(check(manifest([capture({ viewport: { width: 800, height: 600 } })]))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('800x600'),
    });
  });

  it('rejects files outside the out dir', () => {
    for (const file of ['/etc/passwd.png', '../x.png', 'a/../../x.png']) {
      expect(check(manifest([capture({ file })]))).toMatchObject({
        ok: false,
        diagnostic: expect.stringContaining('outside the capture directory'),
      });
    }
  });

  it('rejects a blank or non-PNG capture', () => {
    expect(check(manifest(), Buffer.from('not a png'.repeat(500)))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('not a PNG'),
    });
    expect(check(manifest(), png(100))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('blank or empty image'),
    });
    expect(check(manifest(), png(6 * 1024 * 1024))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('5 MiB'),
    });
    expect(check(manifest(), solidPng())).toMatchObject({
      ok: false,
      diagnostic: '/settings blank image 0.png (uniform colour)',
    });
    const undecodable = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(4096),
    ]);
    expect(check(manifest(), undecodable)).toMatchObject({
      ok: false,
      diagnostic: '/settings image 0.png is not a decodable PNG',
    });
  });

  it('rejects an unreadable image, a malformed manifest and unknown keys', () => {
    const unreadable = validateVisualProofManifest(
      manifest(),
      { headSha: HEAD, runId: RUN, outDir, routes: [route('/settings')] },
      () => {
        throw new Error('ENOENT');
      },
    );
    expect(unreadable).toMatchObject({ ok: false, diagnostic: expect.stringContaining('could not be read') });
    expect(check({ nope: true })).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('invalid capture manifest'),
    });
    expect(check(manifest([], { extra: 1 }))).toMatchObject({ ok: false });
  });
});

describe('validateVisualProofManifest for stateful routes', () => {
  const outDir = resolve('/tmp/out');
  const steps = [{ click: '#new' }, { fill: '#name', value: 'Demo' }, { waitFor: '#item-1' }];
  const stateful = (patch: Partial<VisualProofRoute> = {}): VisualProofRoute => ({
    route: '/items',
    state: 'item-created',
    assert: '#item-1',
    viewport: VIEWPORT,
    steps,
    ...patch,
  });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]);
  const files = (extra: Record<string, Buffer> = {}): Record<string, Buffer> => ({
    'after.png': noisePng(4096, 2),
    'before.png': noisePng(4096, 3),
    'clip.gif': gif,
    ...extra,
  });
  const cap = (patch: Record<string, unknown> = {}) => ({
    route: '/items',
    state: 'item-created',
    viewport: VIEWPORT,
    finalPath: '/items',
    assertion: { target: '#item-1', passed: true },
    file: 'after.png',
    before: { file: 'before.png', finalPath: '/items' },
    steps,
    clip: { file: 'clip.gif', format: 'gif' },
    ...patch,
  });
  const check = (
    caps: Record<string, unknown>[],
    route: VisualProofRoute,
    fileMap: Record<string, Buffer> = files(),
    patch: Record<string, unknown> = {},
  ) =>
    validateVisualProofManifest(
      { headSha: HEAD, runId: RUN, captures: caps, ...patch },
      { headSha: HEAD, runId: RUN, outDir, routes: [route] },
      (path) => {
        const name = path.slice(outDir.length + 1);
        const bytes = fileMap[name];
        if (!bytes) throw new Error('ENOENT');
        return bytes;
      },
    );
  const diagnostic = (result: ReturnType<typeof check>): string => (result.ok ? '' : result.diagnostic);

  it('returns before, steps and the clip for a stateful route', () => {
    const r = check([cap()], stateful({ record: 'gif' }));
    expect(r).toMatchObject({
      ok: true,
      captures: [
        {
          route: '/items',
          file: 'after.png',
          before: { file: 'before.png', finalPath: '/items', bytes: 4096 },
          steps,
          clip: { file: 'clip.gif', format: 'gif', bytes: gif.length },
        },
      ],
    });
  });

  it('accepts webm and mp4 clips for record video', () => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(50)]);
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(50)]);
    const route = stateful({ record: 'video' });
    expect(check([cap({ clip: { file: 'c.webm', format: 'webm' } })], route, files({ 'c.webm': webm })).ok).toBe(true);
    expect(check([cap({ clip: { file: 'c.mp4', format: 'mp4' } })], route, files({ 'c.mp4': mp4 })).ok).toBe(true);
  });

  it('names the failing step from manifest failures', () => {
    const r = check([], stateful(), files(), {
      failures: [{ route: '/items', state: 'item-created', step: 2, message: 'selector not found' }],
    });
    expect(diagnostic(r)).toBe(
      '/items (state item-created) step 2 fill "#name" with "Demo" failed: selector not found',
    );
    const unknownStep = check([], stateful(), files(), {
      failures: [{ route: '/items', state: 'item-created', step: 9, message: 'boom' }],
    });
    expect(diagnostic(unknownStep)).toContain('step 9 ? failed: boom');
    const otherRoute = check([cap()], stateful(), files(), {
      failures: [{ route: '/other', state: 'x', step: 1, message: 'ignored' }],
    });
    expect(otherRoute.ok).toBe(true);
  });

  it('requires a before capture on the route path that is a real image', () => {
    expect(diagnostic(check([cap({ before: undefined })], stateful()))).toContain('has no before capture');
    expect(diagnostic(check([cap({ before: { file: 'before.png', finalPath: '/login' } })], stateful()))).toContain(
      'before capture landed on /login',
    );
    expect(diagnostic(check([cap()], stateful(), files({ 'before.png': solidPng() })))).toContain(
      'blank image before.png (uniform colour)',
    );
  });

  it('rejects an after capture identical to before', () => {
    const same = noisePng(4096, 5);
    const r = check([cap()], stateful(), files({ 'after.png': same, 'before.png': same }));
    expect(diagnostic(r)).toContain('after capture is identical to before — steps had no visible effect');
  });

  it('rejects echoed steps that differ from the configured ones', () => {
    expect(diagnostic(check([cap({ steps: [{ click: '#other' }] })], stateful()))).toContain(
      'steps do not match the configured steps',
    );
    expect(diagnostic(check([cap({ steps: undefined })], stateful()))).toContain(
      'steps do not match the configured steps',
    );
  });

  it('compares the after path with the last goto step', () => {
    const goto = stateful({ steps: [{ goto: '/items/42' }, { click: '#a' }] });
    const echoed = [{ goto: '/items/42' }, { click: '#a' }];
    expect(check([cap({ finalPath: '/items/42', steps: echoed })], goto).ok).toBe(true);
    expect(diagnostic(check([cap({ finalPath: '/items', steps: echoed })], goto))).toContain('expected /items/42');
  });

  it('rejects before or clip on a stepless route', () => {
    const stepless = stateful({ steps: undefined });
    expect(diagnostic(check([cap()], stepless))).toContain('unexpected before/clip for a route without steps');
  });

  it('rejects a missing, misplaced, mismatched, unreadable or oversized clip', () => {
    const route = stateful({ record: 'gif' });
    expect(diagnostic(check([cap({ clip: undefined })], route))).toContain('clip missing');
    expect(diagnostic(check([cap({ clip: { file: 'c.webm', format: 'webm' } })], route))).toContain(
      'clip is not a gif',
    );
    expect(diagnostic(check([cap({ clip: { file: '../c.gif', format: 'gif' } })], route))).toContain(
      'outside the capture directory',
    );
    expect(diagnostic(check([cap({ clip: { file: 'nope.gif', format: 'gif' } })], route))).toContain(
      'could not be read',
    );
    expect(diagnostic(check([cap()], route, files({ 'clip.gif': Buffer.from('not a gif at all') })))).toContain(
      'clip is not a gif',
    );
    const big = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(MAX_CLIP_BYTES)]);
    expect(diagnostic(check([cap()], route, files({ 'clip.gif': big })))).toContain('clip exceeds 10 MiB');
    const video = stateful({ record: 'video' });
    expect(diagnostic(check([cap()], video))).toContain('clip is not a video');
    const mp4Clip = { file: 'c.mp4', format: 'mp4' };
    expect(diagnostic(check([cap({ clip: mp4Clip })], video, files({ 'c.mp4': Buffer.alloc(40) })))).toContain(
      'clip is not a video',
    );
  });
});
