import { describe, expect, it } from 'vitest';

import { createFactorydServer } from './factoryd-http.js';
import { assertFactorydLoopbackHost } from './factoryd-loopback.js';

describe('assertFactorydLoopbackHost', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('accepts %s', (host) => {
    expect(() => assertFactorydLoopbackHost(host)).not.toThrow();
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.com', 'LOCALHOST'])('refuses %s naming ADR-0034', (host) => {
    expect(() => assertFactorydLoopbackHost(host)).toThrow(/ADR-0034/);
  });

  it('createFactorydServer refuses a non-loopback host naming ADR-0034', () => {
    expect(() => createFactorydServer({ host: '0.0.0.0', port: 0, registryFile: '/tmp/unused-registry.json' })).toThrow(
      /ADR-0034/,
    );
  });
});
