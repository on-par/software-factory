import { describe, expect, it } from 'vitest';

import { applyStateRootOption } from './state-root.js';

describe('applyStateRootOption', () => {
  it('lets the flag beat the env var and writes the absolute value back', () => {
    const env: NodeJS.ProcessEnv = { FACTORY_STATE_ROOT: '/from/env' };
    expect(applyStateRootOption('/from/flag', '/repo', env)).toBe('/from/flag');
    expect(env.FACTORY_STATE_ROOT).toBe('/from/flag');
  });

  it('uses the env var when no flag is given', () => {
    const env: NodeJS.ProcessEnv = { FACTORY_STATE_ROOT: '/from/env' };
    expect(applyStateRootOption(undefined, '/repo', env)).toBe('/from/env');
    expect(env.FACTORY_STATE_ROOT).toBe('/from/env');
  });

  it('leaves env untouched when nothing is set', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyStateRootOption(undefined, '/repo', env)).toBeUndefined();
    expect(env).toEqual({});
  });

  it('throws on an invalid value', () => {
    expect(() => applyStateRootOption('relative', '/repo', {})).toThrow(/must be an absolute path/);
  });
});
