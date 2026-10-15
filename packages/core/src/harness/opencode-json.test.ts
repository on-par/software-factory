import { describe, expect, it } from 'vitest';

import { classifyOpenCodeErrorType, parseOpenCodeJson } from './opencode.js';

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
    expect(parsed).toEqual({ text: '', errorText: '', permissionDenials: [] });
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

  const PHRASE = 'This non-interactive run cannot ask the user for permission, so the request was rejected.';
  const toolUse = (part: unknown) => JSON.stringify({ type: 'tool_use', part });

  it('detects the permission rejection in state.output, case-insensitively', () => {
    const out = `\n  ${PHRASE.toUpperCase()}\nmore`;
    const parsed = parseOpenCodeJson(toolUse({ tool: 'edit', state: { status: 'completed', output: out } }));
    expect(parsed?.permissionDenials).toEqual([{ tool: 'edit', message: PHRASE.toUpperCase() }]);
  });

  it("uses 'unknown' when part.tool is missing", () => {
    const parsed = parseOpenCodeJson(toolUse({ state: { status: 'error', error: PHRASE } }));
    expect(parsed?.permissionDenials).toEqual([{ tool: 'unknown', message: PHRASE }]);
  });

  it('does not treat a text event quoting the phrase as a denial', () => {
    const parsed = parseOpenCodeJson(JSON.stringify({ type: 'text', part: { text: PHRASE } }));
    expect(parsed?.permissionDenials).toEqual([]);
  });

  it('ignores malformed tool_use events', () => {
    const stdout = [
      '{"type":"tool_use"}',
      toolUse({ tool: 'bash', state: { error: 42, output: { a: 1 } } }),
      toolUse({ tool: 'bash', state: { status: 'error', error: 'ENOENT' } }),
    ].join('\n');
    expect(parseOpenCodeJson(stdout)?.permissionDenials).toEqual([]);
  });
});

describe('parseOpenCodeJson typed error events', () => {
  const err = (error: unknown) => JSON.stringify({ type: 'error', error });

  it('reports errorType and errorStatus from the first typed error event', () => {
    const parsed = parseOpenCodeJson(
      [
        err({ name: 'X', data: { message: 'untyped' } }),
        err({ type: 'provider.quota', status: 402, data: { message: 'q' } }),
        err({ type: 'provider.auth', status: 401, data: { message: 'a' } }),
      ].join('\n'),
    );
    expect(parsed?.errorType).toBe('provider.quota');
    expect(parsed?.errorStatus).toBe(402);
  });

  it('takes errorStatus from data.statusCode when error.status is absent', () => {
    const parsed = parseOpenCodeJson(err({ type: 'provider.rate-limit', data: { message: 'm', statusCode: 429 } }));
    expect(parsed?.errorStatus).toBe(429);
  });

  it('omits errorType for a non-string or empty type', () => {
    for (const type of ['', 5, null, { a: 1 }]) {
      const parsed = parseOpenCodeJson(err({ type, data: { message: 'm' } }));
      expect(parsed).toEqual({ text: '', errorText: 'm', permissionDenials: [] });
    }
  });

  it('uses the type as the errorText line when message and name are absent', () => {
    const parsed = parseOpenCodeJson(err({ type: 'provider.connect', status: 503 }));
    expect(parsed?.errorText).toBe('provider.connect status 503');
  });
});

describe('classifyOpenCodeErrorType', () => {
  it('maps the listed types', () => {
    expect(
      [
        'provider.rate-limit',
        'provider.quota',
        'provider.auth',
        'provider.timeout',
        'provider.connect',
        'provider.no-route',
      ].map(classifyOpenCodeErrorType),
    ).toEqual(['rate_limit', 'usage_cap', 'local_auth', 'timeout', 'unavailable', 'unavailable']);
  });

  it('returns undefined for missing, unmapped, differently cased and prototype keys', () => {
    for (const t of [undefined, 'provider.content-filter', 'Provider.Quota', 'constructor']) {
      expect(classifyOpenCodeErrorType(t)).toBeUndefined();
    }
  });
});
