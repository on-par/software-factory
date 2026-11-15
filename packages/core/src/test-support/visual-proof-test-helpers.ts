import { crc32, deflateSync } from 'node:zlib';

import type { CommandResult } from '../utils/command-runner.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WIDTH = 64;
const CHANNELS = 4;
const ROW_BYTES = WIDTH * CHANNELS;

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const encode = (rows: Buffer[]): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(rows.length, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])));
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

export const noisePng = (approxBytes = 4096, seed = 1): Buffer => {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
  const rowCount = Math.max(1, Math.ceil(approxBytes / ROW_BYTES));
  return encode(Array.from({ length: rowCount }, () => Buffer.from(Array.from({ length: ROW_BYTES }, next))));
};

export const solidPng = (): Buffer => {
  const rowCount = Math.ceil(2048 / ROW_BYTES) + 1;
  return encode(Array.from({ length: rowCount }, () => Buffer.alloc(ROW_BYTES, 0xff)));
};

export const cmdResult = (patch: Partial<CommandResult> = {}): CommandResult => ({
  command: [],
  stdout: '',
  stderr: '',
  exitCode: 0,
  killed: false,
  timedOut: false,
  ok: true,
  ...patch,
});
