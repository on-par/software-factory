import { describe, expect, it } from 'vitest';

import { isPublicAddress, isPublicHttpUrl, maskUrl } from './preview-url-guard.js';

describe('isPublicHttpUrl', () => {
  it.each([
    'https://pr-7.preview.example.com',
    'http://example.org:8080/app',
    'https://93.184.216.34/',
    'https://[2606:4700::1111]/',
  ])('accepts the public http(s) URL %s', (url) => {
    expect(isPublicHttpUrl(url)).toBe(true);
  });

  it.each([
    ['a non-http scheme', 'ftp://example.com/'],
    ['a file URL', 'file:///etc/passwd'],
    ['a URL that does not parse', 'not a url'],
    ['embedded credentials', 'https://user:pass@example.com/'],
    ['localhost', 'http://localhost:3000/'],
    ['a localhost subdomain', 'http://app.localhost/'],
    ['an mDNS .local host', 'http://printer.local/'],
    ['an .internal host', 'https://api.corp.internal/'],
    ['a single-label host', 'http://intranet/'],
    ['IPv4 loopback', 'http://127.0.0.1/'],
    ['IPv4 loopback in decimal form', 'http://2130706433/'],
    ['IPv4 loopback in hex form', 'http://0x7f.1/'],
    ['the unspecified IPv4 address', 'http://0.0.0.0/'],
    ['10/8', 'http://10.1.2.3/'],
    ['172.16/12', 'http://172.31.255.255/'],
    ['192.168/16', 'http://192.168.0.10/'],
    ['IPv4 link-local metadata', 'http://169.254.169.254/latest/meta-data'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv6 unique-local', 'http://[fd12:3456::1]/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped IPv6 private', 'http://[::ffff:10.0.0.1]/'],
  ])('rejects %s', (_name, url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });
});

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '172.32.0.1', '2001:4860:4860::8888'])('accepts the public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '127.8.8.8',
    '172.16.0.1',
    '169.254.1.1',
    '::',
    'fc00::1',
    'febf::1',
    '::ffff:192.168.1.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    'ff02::1',
    '224.0.0.1',
    'fe80::1%en0',
  ])('rejects the non-public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it('rejects text that is not an IP address', () => {
    expect(isPublicAddress('example.com')).toBe(false);
  });
});

describe('maskUrl', () => {
  it('hides the query string and fragment of a logged URL', () => {
    expect(maskUrl('https://p.example.com/app?token=secret#frag')).toBe('https://p.example.com/app?***');
  });

  it('leaves a URL without a query string as it is', () => {
    expect(maskUrl('https://p.example.com/app')).toBe('https://p.example.com/app');
  });

  it('hides embedded credentials', () => {
    expect(maskUrl('https://u:p@p.example.com/')).toBe('https://***@p.example.com/');
  });

  it('masks text that does not parse as a URL', () => {
    expect(maskUrl('?token=x')).toBe('***');
  });
});
