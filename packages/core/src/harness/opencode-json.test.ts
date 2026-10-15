import { describe, expect, it } from 'vitest';

import { parseOpenCodeJson } from './opencode.js';

describe('parseOpenCodeJson', () => {
  it('sets durationMs to the span between the smallest and largest event timestamps', () => {
    const parsed = parseOpenCodeJson(
      [
        '{"type":"step_start","timestamp":1700000012345}',
        '{"type":"text","timestamp":1700000000000,"part":{"text":"hi"}}',
        '{"type":"step_finish","timestamp":1700000006000,"part":{"tokens":{"input":5,"output":2}}}',
      ].join('\n'),
    );
    expect(parsed?.usage?.durationMs).toBe(12345);
  });

  it('omits durationMs when no event has a finite timestamp', () => {
    const parsed = parseOpenCodeJson(
      [
        '{"type":"step_start"}',
        '{"type":"text","timestamp":"1700000000000","part":{"text":"hi"}}',
        '{"type":"step_finish","part":{"tokens":{"input":5,"output":2}}}',
      ].join('\n'),
    );
    expect(parsed?.usage).toBeDefined();
    expect(parsed?.usage).not.toHaveProperty('durationMs');
  });

  it('leaves usage undefined when timestamps exist but no step_finish has numeric tokens', () => {
    const parsed = parseOpenCodeJson('{"type":"step_start","timestamp":1700000000000}');
    expect(parsed?.usage).toBeUndefined();
  });

  it('returns undefined for empty and non-JSON text', () => {
    expect(parseOpenCodeJson('')).toBeUndefined();
    expect(parseOpenCodeJson('hello\n42\n[1]\n{"a":1}')).toBeUndefined();
  });

  it('skips malformed lines mixed with valid events', () => {
    const parsed = parseOpenCodeJson('{bad\n{"type":"text","part":{"text":"  hi  "}}\nnull\n');
    expect(parsed?.text).toBe('hi');
    expect(parsed?.usage).toBeUndefined();
  });

  it('leaves usage undefined when step_finish has no numeric tokens', () => {
    const parsed = parseOpenCodeJson(
      '{"type":"step_finish","part":{"cost":1}}\n{"type":"step_finish","part":{"tokens":{"input":"x"}}}',
    );
    expect(parsed).toEqual({ text: '', errorText: '' });
  });

  it('omits costUsd when the cost is 0 and tolerates a missing cache block', () => {
    const parsed = parseOpenCodeJson('{"type":"step_finish","part":{"cost":0,"tokens":{"input":5,"output":2}}}');
    expect(parsed?.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      rawInputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      numTurns: 1,
    });
  });

  it('falls back to error.name when there is no data.message', () => {
    const parsed = parseOpenCodeJson('{"type":"error","error":{"name":"APIError"}}\n{"type":"error","error":{}}');
    expect(parsed?.errorText).toBe('APIError');
  });

  it('appends responseBody and status to errorText', () => {
    const parsed = parseOpenCodeJson(
      '{"type":"error","error":{"name":"APIError","data":{"message":"Forbidden","statusCode":403,"responseBody":"usage limit"}}}',
    );
    expect(parsed?.errorText).toBe('Forbidden usage limit status 403');
  });

  it('ignores non-string responseBody and non-numeric statusCode', () => {
    const parsed = parseOpenCodeJson(
      '{"type":"error","error":{"data":{"message":"Boom","statusCode":"429","responseBody":{"a":1}}}}',
    );
    expect(parsed?.errorText).toBe('Boom');
  });
});
