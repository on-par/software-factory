import { inflateSync } from 'node:zlib';

const PNG_HEADER_BYTES = 8;
const IHDR_BYTES = 13;
const BLANK_DISTINCT_BYTES = 8;

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function isBlankPng(bytes: Buffer): boolean | 'undecodable' {
  try {
    let width = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = 0;
    let sawHeader = false;
    const data: Buffer[] = [];
    let offset = PNG_HEADER_BYTES;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('latin1', offset + 4, offset + 8);
      const start = offset + 8;
      if (start + length + 4 > bytes.length) return 'undecodable';
      if (type === 'IHDR' && length >= IHDR_BYTES) {
        width = bytes.readUInt32BE(start);
        bitDepth = bytes[start + 8] ?? 0;
        colorType = bytes[start + 9] ?? -1;
        interlace = bytes[start + 12] ?? 0;
        sawHeader = true;
      } else if (type === 'IDAT') {
        data.push(bytes.subarray(start, start + length));
      } else if (type === 'IEND') {
        break;
      }
      offset = start + length + 4;
    }
    const channels = CHANNELS_BY_COLOR_TYPE[colorType];
    if (!sawHeader || data.length === 0 || channels === undefined || width === 0 || bitDepth === 0) {
      return 'undecodable';
    }
    const raw = inflateSync(Buffer.concat(data));
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
    const distinct = new Set<number>();
    for (let i = 0; i < raw.length; i++) {
      if (interlace === 0 && i % (rowBytes + 1) === 0) continue;
      distinct.add(raw[i] ?? 0);
      if (distinct.size >= BLANK_DISTINCT_BYTES) return false;
    }
    return distinct.size < BLANK_DISTINCT_BYTES;
  } catch {
    return 'undecodable';
  }
}
