import { describe, expect, it } from 'vitest';

import { loadFactoryConfig, resolveMergePolicy, resolvePrClassifierPolicy } from './index.js';

describe('resolveMergePolicy / resolvePrClassifierPolicy flag › repo › env › default table', () => {
  const config = loadFactoryConfig();
  const withRun = (merge: Record<string, boolean>) => ({ ...config, run: { merge } });

  it.each([
    ['flag', withRun({ auto: false }), { FACTORY_MERGE: '1' }, { auto: true }, true, 'flag'],
    ['run.merge.auto false beats env', withRun({ auto: false }), { FACTORY_MERGE: '1' }, {}, false, 'repo'],
    ['run.merge.auto true', withRun({ auto: true }), {}, {}, true, 'repo'],
    ['legacy merge.auto', { ...config, merge: { ...config.merge, auto: true } }, {}, {}, true, 'repo'],
    ['env', config, { FACTORY_MERGE: '1' }, {}, true, 'env'],
    ['env other than 1', config, { FACTORY_MERGE: 'true' }, {}, false, 'default'],
    ['default', config, {}, {}, false, 'default'],
  ] as const)('auto: %s', (_name, cfg, env, overrides, value, source) => {
    const result = resolveMergePolicy(cfg, env, overrides);
    expect(result.auto).toBe(value);
    expect(result.sources.auto).toBe(source);
  });

  it.each([
    ['repo', withRun({ admin: false }), { FACTORY_MERGE_ADMIN: '1' }, false, 'repo'],
    ['env', config, { FACTORY_MERGE_ADMIN: '1' }, true, 'env'],
    ['default', config, {}, false, 'default'],
  ] as const)('admin: %s', (_name, cfg, env, value, source) => {
    const result = resolveMergePolicy(cfg, env);
    expect(result.admin).toBe(value);
    expect(result.sources.admin).toBe(source);
  });

  it.each([
    ['flag', withRun({ classifier: false }), { FACTORY_PR_CLASSIFIER: '1' }, { classifier: true }, true, 'flag'],
    ['repo', withRun({ classifier: false }), { FACTORY_PR_CLASSIFIER: '1' }, {}, false, 'repo'],
    ['env', config, { FACTORY_PR_CLASSIFIER: '1' }, {}, true, 'env'],
    ['default', config, {}, {}, false, 'default'],
  ] as const)('classifier: %s', (_name, cfg, env, overrides, enabled, source) => {
    expect(resolvePrClassifierPolicy(cfg, env, overrides)).toEqual({ enabled, source });
  });
});
