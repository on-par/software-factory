import { describe, expect, it } from 'vitest';
import { evaluatePushChecks, evaluateRequiredChecks } from './required-checks.js';

describe('hosted check states', () => {
  it('distinguishes completed failures, pending checks, and success', () => {
    const failed = { name: 'ci', status: 'completed', conclusion: 'failure' };
    const pending = { name: 'ci', status: 'in_progress', conclusion: null };
    const green = { name: 'ci', status: 'completed', conclusion: 'success' };
    expect(evaluateRequiredChecks(['ci'], [failed, pending]).state).toBe('failed');
    expect(evaluateRequiredChecks(['ci'], []).state).toBe('pending');
    expect(evaluatePushChecks([pending]).state).toBe('pending');
    expect(evaluatePushChecks([green]).state).toBe('green');
  });
});
