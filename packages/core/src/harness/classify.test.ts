// src/harness/classify.test.ts — table-driven coverage for Codex/ChatGPT limit classification.

import { describe, expect, it } from 'vitest';

import { classifyFailure } from './classify.js';

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
    ['billing issue: payment required', 'usage_cap'],
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
