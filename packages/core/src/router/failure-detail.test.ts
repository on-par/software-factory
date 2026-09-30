import { describe, expect, it } from 'vitest';

import { HarnessError } from '../harness/index.js';
import { describeFailureDetail, redactSecrets } from './failure-detail.js';

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

  it('includes top-level stdout in the rendered detail', () => {
    const err = Object.assign(new Error('boom'), { stdout: 'Invalid API key · Please run /login' });

    const detail = describeFailureDetail(err);

    expect(detail).toContain('stdout="Invalid API key · Please run /login"');
  });

  it('reads stdout from a details bag when there is no top-level stdout', () => {
    const err = { message: 'boom', details: { stdout: 'Invalid API key · Please run /login' } };

    const detail = describeFailureDetail(err);

    expect(detail).toContain('stdout="Invalid API key · Please run /login"');
  });

  it('truncates an overlong stdout to 400 chars plus an ellipsis', () => {
    const err = Object.assign(new Error('boom'), { stdout: 'c'.repeat(500) });

    const detail = describeFailureDetail(err);

    expect(detail).toContain(`stdout="${'c'.repeat(400)}…"`);
  });

  it('redacts secrets found in stdout', () => {
    const err = Object.assign(new Error('boom'), { stdout: 'token: hunter2 rest' });

    const detail = describeFailureDetail(err);

    expect(detail).toContain('stdout="token: [redacted] rest"');
    expect(detail).not.toContain('hunter2');
  });

  it('prefers details.diagnostic over the raw stdout dump when present', () => {
    const err = new HarnessError('claude CLI process exited 1', 'usage_cap', {
      exitCode: 1,
      stdout: `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${'x'.repeat(500)}`,
      diagnostic: 'You have reached your monthly limit.',
    });

    const detail = describeFailureDetail(err);

    expect(detail).toContain('diagnostic="You have reached your monthly limit."');
    expect(detail).not.toContain('stdout="');
  });

  it('falls back to stdout when there is no diagnostic', () => {
    const err = new HarnessError('claude CLI process exited 1', 'error', { exitCode: 1, stdout: 'plain stdout' });

    const detail = describeFailureDetail(err);

    expect(detail).toContain('stdout="plain stdout"');
    expect(detail).not.toContain('diagnostic="');
  });

  it('truncates an overlong diagnostic to 400 chars plus an ellipsis', () => {
    const err = new HarnessError('boom', 'usage_cap', { exitCode: 1, diagnostic: 'd'.repeat(500) });

    const detail = describeFailureDetail(err);

    expect(detail).toContain(`diagnostic="${'d'.repeat(400)}…"`);
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

  it('redacts credentials embedded in a URL', () => {
    expect(redactSecrets("fatal: unable to access 'https://oauth2:glpat-abc123@gitlab.com/o/r.git/'")).toBe(
      "fatal: unable to access 'https://[redacted]@gitlab.com/o/r.git/'",
    );
    expect(redactSecrets('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });
});
