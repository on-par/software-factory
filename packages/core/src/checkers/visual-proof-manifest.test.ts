import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { VisualProofStep } from '../config/visual-proof-section.js';
import {
  describeVisualProofStep,
  MAX_CLIP_BYTES,
  validateVisualProofManifest,
  type VisualProofRoute,
} from './visual-proof-manifest.js';
import { isBlankPng } from './visual-proof-png.js';
import { noisePng, solidPng } from './visual-proof-test-helpers.js';

const HEAD = 'a'.repeat(40);
const RUN = 'run-1';
const VIEWPORT = { width: 1280, height: 800 };
const outDir = resolve('/tmp/out');

describe('isBlankPng', () => {
  it('tells noise, a solid colour and garbage apart', () => {
    expect(isBlankPng(noisePng())).toBe(false);
    expect(isBlankPng(solidPng())).toBe(true);
    expect(isBlankPng(Buffer.from('definitely not a png'))).toBe('undecodable');
    expect(isBlankPng(noisePng().subarray(0, 60))).toBe('undecodable');
  });
});

describe('describeVisualProofStep', () => {
  it('renders every step kind', () => {
    const steps: VisualProofStep[] = [
      { goto: '/x' },
      { click: '#sel' },
      { fill: '#sel', value: 'v' },
      { press: 'Enter' },
      { waitFor: 'text' },
    ];
    expect(steps.map(describeVisualProofStep)).toEqual([
      'goto /x',
      'click "#sel"',
      'fill "#sel" with "v"',
      'press Enter',
      'waitFor "text"',
    ]);
  });
});

describe('validateVisualProofManifest with steps (#4054)', () => {
  const steps: VisualProofStep[] = [{ click: '#new' }, { click: '#missing' }];
  const statefulRoute = (patch: Partial<VisualProofRoute> = {}): VisualProofRoute => ({
    route: '/items',
    state: 'item-created',
    assert: '#item-1',
    viewport: VIEWPORT,
    steps,
    ...patch,
  });
  const before = noisePng(4096, 1);
  const after = noisePng(4096, 2);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)]);
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(100)]);
  const capture = (patch: Record<string, unknown> = {}) => ({
    route: '/items',
    state: 'item-created',
    viewport: VIEWPORT,
    finalPath: '/items',
    assertion: { target: '#item-1', passed: true },
    file: 'after.png',
    before: { file: 'before.png', finalPath: '/items' },
    steps,
    ...patch,
  });
  const manifest = (caps: Record<string, unknown>[] = [capture()], patch: Record<string, unknown> = {}) => ({
    captures: caps,
    headSha: HEAD,
    runId: RUN,
    ...patch,
  });
  const files = (extra: Record<string, Buffer> = {}): Record<string, Buffer> => ({
    'after.png': after,
    'before.png': before,
    ...extra,
  });
  const check = (raw: unknown, routes: VisualProofRoute[], byName: Record<string, Buffer> = files()) =>
    validateVisualProofManifest(raw, { headSha: HEAD, runId: RUN, outDir, routes }, (path) => {
      const name = path.split('/').pop() ?? '';
      const bytes = byName[name];
      if (!bytes) throw new Error('ENOENT');
      return bytes;
    });
  const diagnosticOf = (r: ReturnType<typeof check>): string => (r.ok ? '' : r.diagnostic);

  it('a stateful route produces before and after captures and a clip', () => {
    const r = check(
      manifest([capture({ clip: { file: 'clip.gif', format: 'gif' } })]),
      [statefulRoute({ record: 'gif' })],
      files({ 'clip.gif': gif }),
    );
    expect(r).toEqual({
      ok: true,
      captures: [
        {
          route: '/items',
          state: 'item-created',
          viewport: VIEWPORT,
          finalPath: '/items',
          file: 'after.png',
          bytes: after.length,
          before: { file: 'before.png', finalPath: '/items', bytes: before.length },
          steps,
          clip: { file: 'clip.gif', format: 'gif', bytes: gif.length },
        },
      ],
    });
  });

  it('a broken selector fails with a reason naming the step', () => {
    const r = check(
      manifest([], { failures: [{ route: '/items', state: 'item-created', step: 2, message: 'no element' }] }),
      [statefulRoute()],
    );
    expect(diagnosticOf(r)).toContain('step 2 click "#missing" failed: no element');
  });

  it('ignores failures for routes that were not selected', () => {
    const r = check(manifest([capture()], { failures: [{ route: '/other', state: 'x', step: 1, message: 'boom' }] }), [
      statefulRoute(),
    ]);
    expect(r.ok).toBe(true);
  });

  it('requires a before capture for a stateful route', () => {
    expect(diagnosticOf(check(manifest([capture({ before: undefined })]), [statefulRoute()]))).toContain(
      'has no before capture',
    );
  });

  it('rejects a before capture that landed elsewhere or is blank', () => {
    const landed = capture({ before: { file: 'before.png', finalPath: '/login' } });
    expect(diagnosticOf(check(manifest([landed]), [statefulRoute()]))).toContain('before capture landed on /login');
    expect(diagnosticOf(check(manifest(), [statefulRoute()], files({ 'before.png': solidPng() })))).toContain(
      'blank image before.png (uniform colour)',
    );
  });

  it('rejects a stateful after capture identical to before', () => {
    const r = check(manifest(), [statefulRoute()], files({ 'after.png': before }));
    expect(diagnosticOf(r)).toContain('after capture is identical to before — steps had no visible effect');
  });

  it('rejects echoed steps that differ from the configured ones', () => {
    expect(diagnosticOf(check(manifest([capture({ steps: [{ click: '#new' }] })]), [statefulRoute()]))).toContain(
      'steps do not match the configured steps',
    );
  });

  it('rejects a blank or undecodable after image', () => {
    const blank = check(manifest(), [statefulRoute()], files({ 'after.png': solidPng() }));
    expect(diagnosticOf(blank)).toContain('blank image after.png (uniform colour)');
    const garbage = Buffer.concat([noisePng().subarray(0, 8), Buffer.alloc(4096, 7)]);
    expect(diagnosticOf(check(manifest(), [statefulRoute()], files({ 'after.png': garbage })))).toContain(
      'is not a decodable PNG',
    );
  });

  it('expects the last goto path for the after capture', () => {
    const route = statefulRoute({ steps: [{ goto: '/items/1' }, { click: '#new' }] });
    const moved = manifest([capture({ finalPath: '/items/1', steps: route.steps })]);
    expect(check(moved, [route]).ok).toBe(true);
    const stayed = manifest([capture({ steps: route.steps })]);
    expect(diagnosticOf(check(stayed, [route]))).toContain('expected /items/1');
  });

  it('rejects before or clip on a route without steps', () => {
    const plain = statefulRoute({ steps: undefined });
    expect(diagnosticOf(check(manifest(), [plain]))).toContain('unexpected before/clip for a route without steps');
  });

  it('reports the underlying read error when a declared clip file cannot be read', () => {
    const route = statefulRoute({ record: 'gif' });
    const declared = manifest([capture({ clip: { file: 'clip.bin', format: 'gif' } })]);
    expect(diagnosticOf(check(declared, [route]))).toContain('clip clip.bin could not be read: ENOENT');
  });

  it('rejects a clip over the size cap or with the wrong format', () => {
    const route = statefulRoute({ record: 'gif' });
    const withClip = (format: string) => manifest([capture({ clip: { file: 'clip.bin', format } })]);
    const run = (format: string, bytes: Buffer) =>
      diagnosticOf(check(withClip(format), [route], files({ 'clip.bin': bytes })));
    expect(diagnosticOf(check(manifest(), [route]))).toContain('clip missing');
    expect(run('gif', Buffer.from('not-a-gif-at-all'))).toContain('clip is not a gif');
    expect(run('webm', webm)).toContain('clip is not a gif');
    const big = Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(MAX_CLIP_BYTES)]);
    expect(run('gif', big)).toContain('clip exceeds 10 MiB');
    const video = statefulRoute({ record: 'video' });
    const asVideo = (format: string, bytes: Buffer) =>
      diagnosticOf(check(withClip(format), [video], files({ 'clip.bin': bytes })));
    expect(asVideo('webm', gif)).toContain('clip is not a video');
    expect(asVideo('gif', gif)).toContain('clip is not a video');
    expect(check(withClip('webm'), [video], files({ 'clip.bin': webm })).ok).toBe(true);
    expect(check(withClip('mp4'), [video], files({ 'clip.bin': mp4 })).ok).toBe(true);
    expect(diagnosticOf(check(withClip('mp4'), [video], files({ 'clip.bin': webm })))).toContain('clip is not a video');
  });

  it('rejects a clip path outside the capture directory', () => {
    const route = statefulRoute({ record: 'gif' });
    const escaped = manifest([capture({ clip: { file: '../clip.gif', format: 'gif' } })]);
    expect(diagnosticOf(check(escaped, [route]))).toContain('outside the capture directory');
  });
});
