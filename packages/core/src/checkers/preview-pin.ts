import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { isPublicAddress, isPublicHttpUrl, maskUrl } from './preview-url-guard.js';

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export type PreviewHostVet = { ok: true; pin: PinnedAddress } | { ok: false; reason: string };

const PROBE_TIMEOUT_MS = 5000;

const bareHost = (hostname: string): string => hostname.replace(/^\[(.*)\]$/, '$1');

export async function vetPreviewHost(
  url: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<PreviewHostVet> {
  if (!isPublicHttpUrl(url)) return { ok: false, reason: `preview URL ${maskUrl(url)} is not a public http(s) host` };
  const { hostname } = new URL(url);
  const host = bareHost(hostname);
  const addresses = isIP(host) === 0 ? await resolveHost(hostname) : [host];
  const blocked = addresses.find((address) => !isPublicAddress(address));
  if (blocked !== undefined) {
    return { ok: false, reason: `preview host ${hostname} resolves to non-public address ${blocked}` };
  }
  const [address] = addresses;
  if (address === undefined) return { ok: false, reason: `preview host ${hostname} resolves to no address` };
  return { ok: true, pin: { address, family: isIP(address) === 6 ? 6 : 4 } };
}

export const pinnedLookup =
  (pin: PinnedAddress): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: pin.address, family: pin.family }]);
    else callback(null, pin.address, pin.family);
  };

export function probePinned(url: string, pin: PinnedAddress): Promise<number | null> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const host = bareHost(target.hostname);
  const options: RequestOptions = {
    agent: false,
    lookup: pinnedLookup(pin),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    ...(isIP(host) === 0 ? { servername: host } : {}),
  };
  return new Promise((resolve) => {
    const req = send(target, options, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}
