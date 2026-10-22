// src/harness/classify.test.ts — table-driven coverage for Codex/ChatGPT limit classification.

import { describe, expect, it } from 'vitest';

import { classifyFailure, isRejectedCredential } from './classify.js';

describe('classifyFailure', () => {
  it.each([
    ['stream error: 429 Too Many Requests', 'rate_limit'],
    ['HTTP 429', 'rate_limit'],
    ['Rate limit reached for gpt-5', 'rate_limit'],
    ['rate_limit_exceeded', 'rate_limit'],
    ['429 too many', 'rate_limit'],
    ["You've hit your usage limit for GPT-5.", 'usage_cap'],
    ['You have reached your plan limit.', 'usage_cap'],
    ['Your usage limit will reset at 3:00 PM.', 'usage_cap'],
    ['You have reached your monthly limit.', 'usage_cap'],
    ['quota exceeded', 'usage_cap'],
    ['insufficient credit', 'usage_cap'],
    ['insufficient credits', 'usage_cap'],
    ['insufficient balance', 'usage_cap'],
    ['insufficient funds', 'usage_cap'],
    ['credits exhausted', 'usage_cap'],
    ['credit balance too low: please add funds', 'usage_cap'],
    ['billing issue: payment required', 'usage_cap'],
    ['insufficient permissions to access this resource', 'unknown'],
    ['accreditation renewal required', 'unknown'],
    ['exit code 1', 'unknown'],
    ['Failed to authenticate: OAuth session expired and could not be refreshed', 'local_auth'],
    ['Please run /login to continue', 'local_auth'],
    ['Error: Cannot find module "x"', 'error'],
    ['AssertionError: expected 3 to equal 4', 'error'],
    ['TypeError: undefined is not a function\n    at index.ts:429:10', 'error'],
    ['Tests failed: 2 passed, 1 failed', 'error'],
    ['mysterious unrecognized output', 'unknown'],
  ])('classifies %j as %s', (stderr, expected) => {
    expect(classifyFailure(stderr, 1)).toBe(expected);
  });

  it('classifies any exit code 124 as timeout regardless of stderr', () => {
    expect(classifyFailure('anything', 124)).toBe('timeout');
  });

  const buildFailureSamples = [
    'Error: Cannot find module "x"',
    'AssertionError: expected 3 to equal 4',
    'TypeError: undefined is not a function\n    at index.ts:429:10',
    'Tests failed: 2 passed, 1 failed',
  ];

  it.each(buildFailureSamples)('never classifies ordinary build failure %j as usage_cap or rate_limit', (stderr) => {
    const result = classifyFailure(stderr, 1);
    expect(result).not.toBe('usage_cap');
    expect(result).not.toBe('rate_limit');
  });
});

describe('classifyFailure cli_missing (#2493)', () => {
  it('classifies exit 127 and command-not-found output as cli_missing', () => {
    expect(classifyFailure('', 127)).toBe('cli_missing');
    expect(classifyFailure('/bin/sh: 1: codex: not found', 1)).toBe('cli_missing');
    expect(classifyFailure('bash: codex: command not found', 1)).toBe('cli_missing');
    expect(classifyFailure('spawn codex ENOENT', 1)).toBe('cli_missing');
  });
  it('keeps unrelated failures as before', () => {
    expect(classifyFailure('file not found in diff', 1)).not.toBe('cli_missing');
  });
});

describe('classifyFailure codex 401 (#2494)', () => {
  it('classifies a logged-out codex 401 as local_auth', () => {
    expect(
      classifyFailure('unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', 1),
    ).toBe('local_auth');
    expect(classifyFailure('401 Unauthorized', 1)).toBe('local_auth');
  });
  it('does not treat a bare 401 line number as auth', () => {
    expect(classifyFailure('error at line 401: unexpected token', 1)).toBe('error');
  });
});

describe('classifyFailure provider 401 wording (#2901)', () => {
  it.each([
    '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    '401 Incorrect API key provided: sk-...',
    'No auth credentials found',
  ])('classifies %s as local_auth', (text) => {
    expect(classifyFailure(text, 0)).toBe('local_auth');
  });
  it('does not treat unrelated "invalid api ..." text as auth', () => {
    expect(classifyFailure('invalid api version', 1)).not.toBe('local_auth');
  });
});

describe('isRejectedCredential (#3232)', () => {
  it.each(['authentication_error', 'invalid x-api-key', 'Incorrect API key provided: sk-...'])(
    'is true for %s',
    (t) => {
      expect(isRejectedCredential(t)).toBe(true);
      expect(classifyFailure(t, 1)).toBe('local_auth');
    },
  );
  it.each(['Please run /login', 'No auth credentials found', 'missing bearer', '401 Unauthorized'])(
    'is false for %s, which is still local_auth',
    (t) => {
      expect(isRejectedCredential(t)).toBe(false);
      expect(classifyFailure(t, 1)).toBe('local_auth');
    },
  );
});
