// src/testing/otlp-collector.ts — in-test OTLP/HTTP logs collector on port 0. It decodes the standard OTLP
// encodings (http/json and http/protobuf, optionally gzip) into flat records, and can simulate outages.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';

export type OtlpAttrValue = string | number | boolean;

/** One decoded OTLP log record with its resource and scope flattened in. */
export interface OtlpTestRecord {
  eventName?: string;
  body?: string;
  attrs: Record<string, OtlpAttrValue>;
  resource: Record<string, OtlpAttrValue>;
  scope: string;
}

/** `ok` answers 200; `status` answers that code (with optional Retry-After seconds); `hang` never answers;
 *  `refuse` closes the listener so connections are refused until the mode changes. */
export type OtlpCollectorMode = 'ok' | 'hang' | 'refuse' | { status: number; retryAfterSeconds?: number };

export interface OtlpTestCollector {
  /** Base endpoint (for OTEL_EXPORTER_OTLP_ENDPOINT); the logs path is `<endpoint>/v1/logs`. */
  readonly endpoint: string;
  /** Records from requests that were answered 2xx, in arrival order. */
  records(): OtlpTestRecord[];
  /** Every request received: answered status (0 = not answered) and content type. */
  readonly requests: { status: number; contentType: string }[];
  setMode(mode: OtlpCollectorMode): Promise<void>;
  /** Resolves once `predicate` holds for the accepted records, or rejects after `timeoutMs`. */
  waitFor(predicate: (records: OtlpTestRecord[]) => boolean, timeoutMs?: number): Promise<OtlpTestRecord[]>;
  close(): Promise<void>;
}

type Field = { no: number; wire: number; value: bigint | Buffer };

/** Minimal protobuf wire-format reader (varint, fixed64, length-delimited, fixed32). */
function fields(buf: Buffer): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let shift = 0n;
    let v = 0n;
    for (;;) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const no = key >>> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ no, wire, value: varint() });
    else if (wire === 1) {
      out.push({ no, wire, value: buf.readBigUInt64LE(i) });
      i += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      out.push({ no, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ no, wire, value: BigInt(buf.readUInt32LE(i)) });
      i += 4;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

const bytesOf = (f: Field[], no: number): Buffer[] => f.filter((x) => x.no === no).map((x) => x.value as Buffer);

function pbAnyValue(buf: Buffer): OtlpAttrValue | undefined {
  for (const f of fields(buf)) {
    if (f.no === 1) return (f.value as Buffer).toString('utf-8');
    if (f.no === 2) return f.value === 1n;
    if (f.no === 3) return Number(BigInt.asIntN(64, f.value as bigint));
    if (f.no === 4) {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(f.value as bigint);
      return b.readDoubleLE(0);
    }
  }
  return undefined;
}

function pbAttrs(list: Buffer[]): Record<string, OtlpAttrValue> {
  const out: Record<string, OtlpAttrValue> = {};
  for (const kv of list) {
    const f = fields(kv);
    const key = bytesOf(f, 1)[0]?.toString('utf-8') ?? '';
    const value = bytesOf(f, 2)[0];
    const v = value ? pbAnyValue(value) : undefined;
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function decodeProtobuf(buf: Buffer): OtlpTestRecord[] {
  const out: OtlpTestRecord[] = [];
  for (const rl of bytesOf(fields(buf), 1)) {
    const rlf = fields(rl);
    const resource = pbAttrs(bytesOf(fields(bytesOf(rlf, 1)[0] ?? Buffer.alloc(0)), 1));
    for (const sl of bytesOf(rlf, 2)) {
      const slf = fields(sl);
      const scope = bytesOf(fields(bytesOf(slf, 1)[0] ?? Buffer.alloc(0)), 1)[0]?.toString('utf-8') ?? '';
      for (const lr of bytesOf(slf, 2)) {
        const lf = fields(lr);
        const body = bytesOf(lf, 5)[0];
        const bodyValue = body ? pbAnyValue(body) : undefined;
        out.push({
          eventName: bytesOf(lf, 12)[0]?.toString('utf-8'),
          body: typeof bodyValue === 'string' ? bodyValue : undefined,
          attrs: pbAttrs(bytesOf(lf, 6)),
          resource,
          scope,
        });
      }
    }
  }
  return out;
}

interface JsonAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: number | string;
  doubleValue?: number;
}
type JsonKv = { key: string; value: JsonAnyValue };

function jsonValue(v: JsonAnyValue | undefined): OtlpAttrValue | undefined {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  return v.doubleValue;
}

function jsonAttrs(list: JsonKv[] | undefined): Record<string, OtlpAttrValue> {
  const out: Record<string, OtlpAttrValue> = {};
  for (const kv of list ?? []) {
    const v = jsonValue(kv.value);
    if (v !== undefined) out[kv.key] = v;
  }
  return out;
}

function decodeJson(buf: Buffer): OtlpTestRecord[] {
  const req = JSON.parse(buf.toString('utf-8')) as {
    resourceLogs?: {
      resource?: { attributes?: JsonKv[] };
      scopeLogs?: {
        scope?: { name?: string };
        logRecords?: { eventName?: string; body?: JsonAnyValue; attributes?: JsonKv[] }[];
      }[];
    }[];
  };
  const out: OtlpTestRecord[] = [];
  for (const rl of req.resourceLogs ?? []) {
    const resource = jsonAttrs(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const body = jsonValue(lr.body);
        out.push({
          eventName: lr.eventName || undefined,
          body: typeof body === 'string' ? body : undefined,
          attrs: jsonAttrs(lr.attributes),
          resource,
          scope: sl.scope?.name ?? '',
        });
      }
    }
  }
  return out;
}

/** Starts a collector on 127.0.0.1, port 0. */
export async function startOtlpTestCollector(): Promise<OtlpTestCollector> {
  const accepted: OtlpTestRecord[] = [];
  const requests: { status: number; contentType: string }[] = [];
  const sockets = new Set<Socket>();
  const hung = new Set<ServerResponse>();
  let mode: OtlpCollectorMode = 'ok';
  let port = 0;

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const contentType = String(req.headers['content-type'] ?? '');
      const entry = { status: 0, contentType };
      requests.push(entry);
      if (mode === 'hang') {
        hung.add(res);
        return;
      }
      if (typeof mode === 'object') {
        entry.status = mode.status;
        const headers: Record<string, string> = {};
        if (mode.retryAfterSeconds !== undefined) headers['retry-after'] = String(mode.retryAfterSeconds);
        res.writeHead(mode.status, headers).end();
        return;
      }
      let raw = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
      accepted.push(...(contentType.includes('json') ? decodeJson(raw) : decodeProtobuf(raw)));
      entry.status = 200;
      res.writeHead(200, { 'content-type': contentType }).end();
    });
  };

  let server: Server = createServer(handle);
  const listen = (s: Server, p: number) =>
    new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.on('connection', (sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
      });
      s.listen(p, '127.0.0.1', () => {
        port = (s.address() as AddressInfo).port;
        resolve();
      });
    });
  const stop = (s: Server) =>
    new Promise<void>((resolve) => {
      for (const res of hung) res.destroy();
      hung.clear();
      for (const sock of sockets) sock.destroy();
      s.close(() => resolve());
    });
  await listen(server, 0);

  return {
    endpoint: `http://127.0.0.1:${port}`,
    records: () => [...accepted],
    requests,
    async setMode(next) {
      const wasRefusing = mode === 'refuse';
      if (mode === 'hang' && next !== 'hang') {
        for (const res of hung) res.destroy();
        hung.clear();
      }
      mode = next;
      if (next === 'refuse' && !wasRefusing) await stop(server);
      if (next !== 'refuse' && wasRefusing) {
        server = createServer(handle);
        await listen(server, port);
      }
    },
    async waitFor(predicate, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(accepted)) {
        if (Date.now() > deadline) throw new Error(`collector: condition not met after ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return [...accepted];
    },
    async close() {
      if (mode !== 'refuse') await stop(server);
    },
  };
}

/** Records of one command (start, output, end) in emission order (`factory.command.seq`). */
export function commandRecords(records: readonly OtlpTestRecord[], commandId: string): OtlpTestRecord[] {
  return records
    .filter((r) => r.attrs['factory.command.id'] === commandId)
    .sort((a, b) => Number(a.attrs['factory.command.seq']) - Number(b.attrs['factory.command.seq']));
}

/** Rebuilds one stream's redacted text from its output records: a record not marked partial ended a line. */
export function reassembleStream(records: readonly OtlpTestRecord[], commandId: string, stream: string): string {
  return commandRecords(records, commandId)
    .filter((r) => r.eventName === 'factory.command.output' && r.attrs['log.iostream'] === stream)
    .map((r) => `${r.body ?? ''}${r.attrs['factory.output.partial'] === true ? '' : '\n'}`)
    .join('');
}
