import { describe, expect, it } from 'vitest';

import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { loadFactoryConfig, loadModelsConfig, loadRoutesConfig, resolveMergePolicy } from './index.js';
import { describeEffectiveConfig, resolveUsageCap, resolveWatchdogPolicy } from './repo.js';

const models = loadModelsConfig();
const routes = loadRoutesConfig();

describe('resolveUsageCap / resolveWatchdogPolicy flag › repo › env › default table', () => {
  it.each([
    ['repo', { version: 2 as const, budget: { capUsd: 50 } }, { FACTORY_USAGE_CAP: '100' }, 50, 'repo'],
    ['env', null, { FACTORY_USAGE_CAP: '100' }, 100, 'env'],
    ['default', null, {}, 227, 'default'],
  ] as const)('usage cap: %s', (_name, repo, env, cap, source) => {
    expect(resolveUsageCap(repo, env)).toEqual({ cap, source });
  });

  it('does not validate a malformed env cap when the repo value is set', () => {
    expect(resolveUsageCap({ version: 2, budget: { capUsd: 5 } }, { FACTORY_USAGE_CAP: 'abc' })).toEqual({
      cap: 5,
      source: 'repo',
    });
    expect(() => resolveUsageCap(null, { FACTORY_USAGE_CAP: 'abc' })).toThrow(
      'FACTORY_USAGE_CAP must be a positive number',
    );
  });

  const wd = (watchdog: Record<string, number | boolean>) => ({ version: 2 as const, budget: { watchdog } });

  it.each([
    ['stopAt', 'stopAt', 0.9, 0.8, 'FACTORY_STOP_AT', '0.7', 0.7, 0.75, 'stopAt'],
    ['resumeAt', 'resumeAt', 0.5, 0.4, 'FACTORY_RESUME_AT', '0.3', 0.3, 0.65, 'resumeAt'],
    ['pollSeconds', 'pollSeconds', 10, 20, 'FACTORY_USAGE_POLL', '30', 30_000, 180_000, 'pollMs'],
  ] as const)('%s: flag, repo, env, default', (_n, key, flagVal, repoVal, envVar, envVal, envOut, defOut, outKey) => {
    const repo = wd({ [key]: repoVal });
    const env = { [envVar]: envVal };
    const scale = key === 'pollSeconds' ? 1000 : 1;
    const flagged = resolveWatchdogPolicy(repo, env, { [key]: flagVal });
    expect(flagged[outKey]).toBe(flagVal * scale);
    expect(flagged.sources[outKey]).toBe('flag');
    const fromRepo = resolveWatchdogPolicy(repo, env);
    expect(fromRepo[outKey]).toBe(repoVal * scale);
    expect(fromRepo.sources[outKey]).toBe('repo');
    const fromEnv = resolveWatchdogPolicy(null, env);
    expect(fromEnv[outKey]).toBe(envOut);
    expect(fromEnv.sources[outKey]).toBe('env');
    const fromDefault = resolveWatchdogPolicy(null, {});
    expect(fromDefault[outKey]).toBe(defOut);
    expect(fromDefault.sources[outKey]).toBe('default');
  });

  it('watch: flag, repo, env, default', () => {
    expect(resolveWatchdogPolicy(wd({ watch: true }), { FACTORY_USAGE_WATCH: '0' }, { watch: false })).toMatchObject({
      watch: false,
      sources: { watch: 'flag' },
    });
    expect(resolveWatchdogPolicy(wd({ watch: false }), { FACTORY_USAGE_WATCH: '1' })).toMatchObject({
      watch: false,
      sources: { watch: 'repo' },
    });
    expect(resolveWatchdogPolicy(null, { FACTORY_USAGE_WATCH: '0' })).toMatchObject({
      watch: false,
      sources: { watch: 'env' },
    });
    expect(resolveWatchdogPolicy(null, { FACTORY_USAGE_WATCH: 'yes' })).toMatchObject({
      watch: true,
      sources: { watch: 'env' },
    });
    expect(resolveWatchdogPolicy(null, {})).toMatchObject({ watch: true, sources: { watch: 'default' } });
  });

  it('estimator: repo, env, default', () => {
    expect(resolveWatchdogPolicy(wd({ estimator: false }), { FACTORY_USAGE_ESTIMATOR: '1' })).toMatchObject({
      estimator: false,
      sources: { estimator: 'repo' },
    });
    expect(resolveWatchdogPolicy(null, { FACTORY_USAGE_ESTIMATOR: '1' })).toMatchObject({
      estimator: true,
      sources: { estimator: 'env' },
    });
    expect(resolveWatchdogPolicy(null, { FACTORY_USAGE_ESTIMATOR: '0' })).toMatchObject({
      estimator: false,
      sources: { estimator: 'env' },
    });
    expect(resolveWatchdogPolicy(null, {})).toMatchObject({ estimator: false, sources: { estimator: 'default' } });
  });

  it('does not validate a malformed env value when a repo value or flag decides', () => {
    expect(resolveWatchdogPolicy(wd({ stopAt: 0.6 }), { FACTORY_STOP_AT: '2' }).stopAt).toBe(0.6);
    expect(resolveWatchdogPolicy(null, { FACTORY_STOP_AT: '2' }, { stopAt: 0.5 }).stopAt).toBe(0.5);
    expect(() => resolveWatchdogPolicy(null, { FACTORY_STOP_AT: '2' })).toThrow(
      'FACTORY_STOP_AT must be a number in (0, 1]',
    );
  });
});

describe('describeEffectiveConfig', () => {
  describe('Merge auto line matches resolveMergePolicy', () => {
    const base = loadFactoryConfig();
    it.each([
      [
        'drift: run.merge.auto false + FACTORY_MERGE=1',
        { ...base, run: { merge: { auto: false } } },
        { FACTORY_MERGE: '1' },
      ],
      ['run.merge.auto true', { ...base, run: { merge: { auto: true } } }, {}],
      ['legacy merge.auto true', { ...base, merge: { ...base.merge, auto: true } }, {}],
      ['env only', base, { FACTORY_MERGE: '1' }],
      ['default', base, {}],
    ])('%s', (_name, config, env) => {
      const router = new ModelRouter(models, routes, false, new StubModelExecutor({ scripts: {} }));
      const policy = resolveMergePolicy(config, env);
      const line = describeEffectiveConfig({
        router,
        repo: null,
        env,
        repoConfigPath: '.factory/config.json',
        mergePolicy: policy,
      }).find((l) => l.startsWith('Merge auto:'));
      const label = { repo: '(.factory/config.json)', env: '(env: FACTORY_MERGE)', default: '(default)', flag: '' }[
        policy.sources.auto
      ];
      expect(line).toBe(`Merge auto: ${policy.auto ? 'on' : 'off'} ${label}`);
    });

    it('without mergePolicy / prClassifier falls back to the env-only resolver result', () => {
      const router = new ModelRouter(models, routes, false, new StubModelExecutor({ scripts: {} }));
      const at = (env: NodeJS.ProcessEnv) => describeEffectiveConfig({ router, repo: null, env, repoConfigPath: 'c' });
      expect(at({})).toContainEqual('Merge auto: off (default)');
      expect(at({ FACTORY_MERGE: '1' })).toContainEqual('Merge auto: on (env: FACTORY_MERGE)');
      expect(at({ FACTORY_PR_CLASSIFIER: '1' })).toContainEqual('PR classifier: on (env: FACTORY_PR_CLASSIFIER)');
      expect(at({})).toContainEqual('PR classifier: off (default)');
    });
  });
});
