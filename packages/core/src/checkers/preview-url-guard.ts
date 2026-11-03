import { isIP, isIPv4 } from 'node:net';

const BLOCKED_IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

const ipv4Number = (ip: string): number => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);

const inRange = (ip: number, [base, bits]: readonly [string, number]): boolean =>
  ip >>> (32 - bits) === ipv4Number(base) >>> (32 - bits);

const isPublicIpv4 = (ip: string): boolean => !BLOCKED_IPV4.some((range) => inRange(ipv4Number(ip), range));

function ipv6Words(ip: string): number[] {
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  const text = isIPv4(tail)
    ? `${ip.slice(0, lastColon + 1)}${(ipv4Number(tail) >>> 16).toString(16)}:${(ipv4Number(tail) & 0xffff).toString(16)}`
    : ip;
  const [head = '', rest] = text.split('::');
  const before = head === '' ? [] : head.split(':');
  const after = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? [] : Array.from({ length: 8 - before.length - after.length }, () => '0');
  return [...before, ...fill, ...after].map((word) => Number.parseInt(word, 16));
}

const embeddedIpv4 = (words: readonly number[]): string =>
  [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff].join('.');

function isPublicIpv6(ip: string): boolean {
  const words = ipv6Words(ip);
  const zeroUntil = (end: number): boolean => words.slice(0, end).every((word) => word === 0);
  if ((words[0] & 0xffc0) === 0xfe80) return false;
  if ((words[0] & 0xfe00) === 0xfc00) return false;
  if ((words[0] & 0xff00) === 0xff00) return false;
  const mapped = zeroUntil(5) && words[5] === 0xffff;
  const nat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
  if (zeroUntil(6) || mapped || nat64) return isPublicIpv4(embeddedIpv4(words));
  return true;
}

export function isPublicAddress(ip: string): boolean {
  const bare = ip.split('%')[0] ?? '';
  const family = isIP(bare);
  if (family === 4) return isPublicIpv4(bare);
  if (family === 6) return isPublicIpv6(bare.toLowerCase());
  return false;
}

export function isPublicHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  if (isIP(host) !== 0) return isPublicAddress(host);
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return host.includes('.');
}

export function isPublicHttpUrl(value: string | null | undefined): value is string {
  if (!value || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  return isPublicHost(url.hostname);
}

export function maskUrl(value: string): string {
  if (!URL.canParse(value)) return '***';
  const url = new URL(value);
  const auth = url.username !== '' || url.password !== '' ? '***@' : '';
  return `${url.protocol}//${auth}${url.host}${url.pathname}${url.search === '' ? '' : '?***'}`;
}

export async function previewHostBlock(
  url: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<string | undefined> {
  if (!isPublicHttpUrl(url)) return `preview URL ${maskUrl(url)} is not a public http(s) host`;
  const { hostname } = new URL(url);
  if (isIP(hostname.replace(/^\[(.*)\]$/, '$1')) !== 0) return undefined;
  const blocked = (await resolveHost(hostname)).find((address) => !isPublicAddress(address));
  return blocked === undefined ? undefined : `preview host ${hostname} resolves to non-public address ${blocked}`;
}
