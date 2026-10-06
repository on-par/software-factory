import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFactoryOctokit,
  formatDeprecation,
  isOctokitDeprecationWarning,
  MAX_THROTTLE_RETRIES,
  onRateLimit,
  onSecondaryRateLimit,
  readDeprecation,
} from './octokit.js';

describe('onRateLimit', () => {
  it('retries while under the bound', () => {
    expect(onRateLimit(60, { method: 'GET', url: '/x' }, undefined, 0)).toBe(true);
  });

  it('stops retrying once the bound is reached', () => {
    expect(onRateLimit(60, { method: 'GET', url: '/x' }, undefined, MAX_THROTTLE_RETRIES)).toBe(false);
  });
});

describe('onSecondaryRateLimit', () => {
  it('retries while under the bound', () => {
    expect(onSecondaryRateLimit(60, { method: 'GET', url: '/x' }, undefined, 0)).toBe(true);
  });

  it('stops retrying once the bound is reached', () => {
    expect(onSecondaryRateLimit(60, { method: 'GET', url: '/x' }, undefined, MAX_THROTTLE_RETRIES)).toBe(false);
  });
});

describe('createFactoryOctokit', () => {
  it('constructs a client with the expected REST surface, given a token', () => {
    const octokit = createFactoryOctokit('t');
    expect(typeof octokit.rest.pulls.list).toBe('function');
  });

  it('constructs a client with no token', () => {
    const octokit = createFactoryOctokit();
    expect(typeof octokit.rest.pulls.list).toBe('function');
  });
});

const DOC = 'https://docs.github.com/en/rest/about-the-rest-api/api-versions';
const DEPRECATED_HEADERS = {
  'content-type': 'application/json',
  deprecation: 'true',
  sunset: 'Fri, 10 Mar 2028 00:00:00 GMT',
  link: `<${DOC}>; rel="deprecation"`,
};

function fakeFetch(headers: Record<string, string>, status = 201): typeof fetch {
  return (async () => new Response(JSON.stringify({ number: 1 }), { status, headers })) as typeof fetch;
}

describe('createFactoryOctokit deprecations (#2218)', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const log = vi.fn();
    const stderr = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const octokit = createFactoryOctokit('t', { log, stderr });
    const create = (headers: Record<string, string>, status = 201) =>
      octokit.rest.issues.create({ owner: 'o', repo: 'r', title: 't', request: { fetch: fakeFetch(headers, status) } });
    return { octokit, log, stderr, warn, error, create };
  }

  it('turns a deprecation into a structured callback', async () => {
    const { log, create } = setup();
    await create(DEPRECATED_HEADERS);
    expect(log).toHaveBeenCalledTimes(1);
    const d = log.mock.calls[0][0];
    expect(d).toEqual({
      method: 'POST',
      route: '/repos/{owner}/{repo}/issues',
      sunset: 'Fri, 10 Mar 2028 00:00:00 GMT',
      sunsetDate: '2028-03-10',
      link: DOC,
    });
    expect(formatDeprecation(d)).toContain('POST /repos/{owner}/{repo}/issues');
    expect(formatDeprecation(d)).toContain('2028-03-10');
  });

  it('collapses repeats per METHOD route', { timeout: 30_000 }, async () => {
    const { octokit, log, stderr, create } = setup();
    for (let i = 0; i < 6; i++) await create(DEPRECATED_HEADERS);
    expect(log).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    await octokit.rest.issues.update({
      owner: 'o',
      repo: 'r',
      issue_number: 1,
      title: 't',
      request: { fetch: fakeFetch(DEPRECATED_HEADERS, 200) },
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0].route).toBe('/repos/{owner}/{repo}/issues/{issue_number}');
  });

  it('never emits the raw Octokit line', async () => {
    const { warn, error, create } = setup();
    await create(DEPRECATED_HEADERS);
    for (const spy of [warn, error]) {
      for (const call of spy.mock.calls) expect(String(call[0]).startsWith('[@octokit/request]')).toBe(false);
    }
  });

  it('recognises only the Octokit deprecation message', () => {
    expect(
      isOctokitDeprecationWarning(
        '[@octokit/request] "POST https://api.github.com/repos/o/r/issues" is deprecated. It is scheduled to be removed on Fri, 10 Mar 2028 00:00:00 GMT',
      ),
    ).toBe(true);
    expect(isOctokitDeprecationWarning('some other warning')).toBe(false);
  });

  it('stays quiet for normal calls', async () => {
    const { log, stderr, create } = setup();
    await create({ 'content-type': 'application/json' });
    expect(log).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('readDeprecation handles missing and odd headers', () => {
    expect(readDeprecation('get', '/x', { deprecation: 'true' })).toEqual({ method: 'GET', route: '/x' });
    expect(readDeprecation('get', '/x', { deprecation: 'true', sunset: 'soon' })).toEqual({
      method: 'GET',
      route: '/x',
      sunset: 'soon',
    });
    expect(readDeprecation('get', '/x', { 'content-type': 'x' })).toBeUndefined();
  });

  it('detects deprecations on error responses and rethrows the original error', async () => {
    const { log, create } = setup();
    await expect(create(DEPRECATED_HEADERS, 404)).rejects.toMatchObject({ status: 404 });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('forwards non-deprecation warnings to console.warn', () => {
    const { octokit, warn } = setup();
    octokit.log.warn('x');
    expect(warn).toHaveBeenCalledWith('x');
  });
});
