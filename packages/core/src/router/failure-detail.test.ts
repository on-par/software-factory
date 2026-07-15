import { describe, expect, it } from 'vitest';
import { describeFailureDetail, redactSecrets } from './failure-detail.js';
import { HarnessError } from '../harness/index.js';

describe('describeFailureDetail', () => {
  it('includes every recognized field from a child-process-shaped error', () => {
    const err = Object.assign(new Error('Command failed: claude -p …'), {
      code: 'EAGAIN',
      exitCode: 1,
      signal: 'SIGKILL',
      killed: true,
      stderr: 'boom',
      tracePath: '/tmp/t.json',
    });

    const detail = describeFailureDetail(err);

    expect(detail).toContain('msg="Command failed: claude -p …"');
    expect(detail).toContain('code=EAGAIN');
    expect(detail).toContain('exitCode=1');
    expect(detail).toContain('signal=SIGKILL');
    expect(detail).toContain('killed=true');
    expect(detail).toContain('stderr="boom"');
    expect(detail).toContain('trace=/tmp/t.json');
  });

  it('omits absent fields', () => {
    expect(describeFailureDetail(new Error('x'))).toBe('msg="x"');
  });

  it('reads tracePath from a details bag when there is no top-level tracePath', () => {
    const err = { message: 'boom', details: { tracePath: '/tmp/t.json' } };

    const detail = describeFailureDetail(err);

    expect(detail).toContain('trace=/tmp/t.json');
  });

  it('reads fields from a HarnessError details bag', () => {
    const err = new HarnessError('claude CLI died', 'unknown', { exitCode: 1, stderr: 'oops', signal: 'SIGTERM' });

    const detail = describeFailureDetail(err);

    expect(detail).toContain('exitCode=1');
    expect(detail).toContain('stderr="oops"');
    expect(detail).toContain('signal=SIGTERM');
  });

  it('truncates an overlong message to 200 chars plus an ellipsis', () => {
    const err = new Error('a'.repeat(250));

    const detail = describeFailureDetail(err);

    expect(detail).toBe(`msg="${'a'.repeat(200)}…"`);
  });

  it('truncates an overlong stderr to 400 chars plus an ellipsis', () => {
    const err = Object.assign(new Error('boom'), { stderr: 'b'.repeat(500) });

    const detail = describeFailureDetail(err);

    expect(detail).toContain(`stderr="${'b'.repeat(400)}…"`);
  });

  it('collapses multiline whitespace to single spaces', () => {
    const err = new Error('line one\n\n  line two\ttabbed');

    const detail = describeFailureDetail(err);

    expect(detail).toBe('msg="line one line two tabbed"');
  });

  it.each([
    ['sk-ant-api03-abcdef1234567890', 'sk-ant-api03-abcdef1234567890'],
    ['ghp_abc123DEF456', 'ghp_abc123DEF456'],
    ['Bearer eyJhbGciOi.something', 'eyJhbGciOi.something'],
    ['ANTHROPIC_API_KEY=sk-live-xyz', 'sk-live-xyz'],
    ['token: hunter2', 'hunter2'],
  ])('redacts secret-shaped substrings: %s', (raw, secret) => {
    const detail = describeFailureDetail(new Error(raw));

    expect(detail).toContain('[redacted]');
    expect(detail).not.toContain(secret);
  });

  it('handles non-object throws', () => {
    expect(describeFailureDetail('string boom')).toBe('string boom');
  });

  it('returns an empty string for null and undefined', () => {
    expect(describeFailureDetail(null)).toBe('');
    expect(describeFailureDetail(undefined)).toBe('');
  });
});

describe('redactSecrets', () => {
  it('redacts an Anthropic API key', () => {
    expect(redactSecrets('sk-ant-api03-abcdef1234567890')).toBe('[redacted]');
  });

  it('redacts a generic sk- prefixed secret', () => {
    expect(redactSecrets('sk-abcdefghijklmnopqrstuvwxyz')).toBe('[redacted]');
  });

  it('redacts GitHub tokens', () => {
    expect(redactSecrets('ghp_abc123DEF456')).toBe('[redacted]');
    expect(redactSecrets('github_pat_abc123DEF456')).toBe('[redacted]');
  });

  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Bearer eyJhbGciOi.something')).toBe('Bearer [redacted]');
  });

  it('redacts key=value style secrets', () => {
    expect(redactSecrets('ANTHROPIC_API_KEY=sk-live-xyz')).toBe('ANTHROPIC_API_KEY=[redacted]');
    expect(redactSecrets('token: hunter2')).toBe('token: [redacted]');
  });
});
