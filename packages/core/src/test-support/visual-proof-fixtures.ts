import { crc32, deflateSync } from 'node:zlib';

import type { CommandResult } from '../utils/command-runner.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_DECODABLE_BYTES = 2048;
const NOISE_RESERVE = 300;
const NOISE_WIDTH = 16;
const RGB_CHANNELS = 3;

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
};

const encode = (width: number, height: number, raw: Buffer): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const noise = (length: number, seed: number): Buffer => {
  const out = Buffer.alloc(length);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
};

export function noisePng(size = 4096, seed = 1): Buffer {
  if (size < MIN_DECODABLE_BYTES) return Buffer.concat([SIGNATURE, Buffer.alloc(size - SIGNATURE.length)]);
  const rowBytes = NOISE_WIDTH * RGB_CHANNELS;
  const height = Math.max(1, Math.floor((size - NOISE_RESERVE) / (rowBytes + 1)));
  const raw = noise(height * (rowBytes + 1), seed);
  for (let row = 0; row < height; row++) raw[row * (rowBytes + 1)] = 0;
  const png = encode(NOISE_WIDTH, height, raw);
  return Buffer.concat([png, Buffer.alloc(Math.max(0, size - png.length))]);
}

export function solidPng(width = 1280, height = 800): Buffer {
  const rowBytes = width * RGB_CHANNELS;
  const raw = Buffer.alloc(height * (rowBytes + 1), 0x20);
  for (let row = 0; row < height; row++) raw[row * (rowBytes + 1)] = 0;
  return encode(width, height, raw);
}

export const okCommandResult = (patch: Partial<CommandResult> = {}): CommandResult => ({
  command: [],
  stdout: '',
  stderr: '',
  exitCode: 0,
  killed: false,
  timedOut: false,
  ok: true,
  ...patch,
});
