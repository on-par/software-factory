import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { loadFactoryConfig, loadFactoryConfigForRepo, type FactoryConfig } from './index.js';
import { resolveReadinessJudgeMode, warnReadinessUpdateBodyOnce } from './readiness-mode.js';

const config = loadFactoryConfig();
const withJudge = (judge: string): FactoryConfig => ({ ...config, readiness: { judge } }) as FactoryConfig;

function collector() {
  const lines: string[] = [];
  return { lines, warn: (line: string) => void lines.push(line) };
}

describe('resolveReadinessJudgeMode (#3470)', () => {
  it('defaults to advisory from the shipped config', () => {
    expect(resolveReadinessJudgeMode(config, {})).toBe('advisory');
  });

  it('uses readiness.judge from the config', () => {
    expect(resolveReadinessJudgeMode(withJudge('enforce'), {})).toBe('enforce');
    expect(resolveReadinessJudgeMode(withJudge('off'), {})).toBe('off');
  });

  it('lets FACTORY_READINESS_JUDGE beat the config, ignoring case and spaces', () => {
    expect(resolveReadinessJudgeMode(withJudge('enforce'), { FACTORY_READINESS_JUDGE: ' Off ' })).toBe('off');
    expect(resolveReadinessJudgeMode(config, { FACTORY_READINESS_JUDGE: 'enforce' })).toBe('enforce');
  });

  it('ignores an unknown FACTORY_READINESS_JUDGE with one warning and keeps the config mode', () => {
    const { lines, warn } = collector();
    expect(resolveReadinessJudgeMode(withJudge('enforce'), { FACTORY_READINESS_JUDGE: 'strict' }, warn)).toBe(
      'enforce',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('FACTORY_READINESS_JUDGE="strict"');
    expect(lines[0]).toContain('enforce, advisory, off');
  });
});

describe('warnReadinessUpdateBodyOnce (#3470)', () => {
  it('warns once that readiness.updateIssueBody is deprecated and ignored, naming the file', () => {
    const { lines, warn } = collector();
    const raw = { readiness: { updateIssueBody: true } };
    warnReadinessUpdateBodyOnce('/r/key-only.yaml', raw, {}, warn);
    warnReadinessUpdateBodyOnce('/r/key-only.yaml', raw, {}, warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/r/key-only.yaml: readiness.updateIssueBody is deprecated and ignored');
    expect(lines[0]).toContain('never edits the ticket body');
  });

  it('warns for FACTORY_READINESS_UPDATE_BODY alone, and names both in one line when both are set', () => {
    const env = collector();
    warnReadinessUpdateBodyOnce('/r/env-only.yaml', {}, { FACTORY_READINESS_UPDATE_BODY: '0' }, env.warn);
    expect(env.lines).toEqual([expect.stringContaining('FACTORY_READINESS_UPDATE_BODY is deprecated and ignored')]);
    const both = collector();
    warnReadinessUpdateBodyOnce(
      '/r/both.yaml',
      { readiness: { updateIssueBody: false } },
      { FACTORY_READINESS_UPDATE_BODY: '1' },
      both.warn,
    );
    expect(both.lines).toHaveLength(1);
    expect(both.lines[0]).toContain(
      '/r/both.yaml: readiness.updateIssueBody and FACTORY_READINESS_UPDATE_BODY are deprecated and ignored',
    );
  });

  it('stays silent when neither the key nor the env var is set', () => {
    const { lines, warn } = collector();
    warnReadinessUpdateBodyOnce('/r/none.yaml', { readiness: { judge: 'enforce' } }, {}, warn);
    warnReadinessUpdateBodyOnce('/r/none.yaml', { readiness: 'x' }, {}, warn);
    expect(lines).toEqual([]);
  });
});

describe('loadFactoryConfigForRepo readiness section (#3470)', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());

  async function load(yaml: string): Promise<{ config: FactoryConfig; lines: string[] }> {
    const path = join(await tempDirs.make('factory-readiness-config-'), 'config.yaml');
    await writeFile(path, yaml);
    const lines: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      loadFactoryConfigForRepo(path);
      return { config: loadFactoryConfigForRepo(path), lines };
    } finally {
      console.warn = realWarn;
    }
  }

  it('accepts readiness.updateIssueBody: true with one deprecation warning across loads and keeps the advisory judge', async () => {
    const { config: loaded, lines } = await load('readiness:\n  updateIssueBody: true\n');
    expect(lines.filter((l) => l.includes('readiness.updateIssueBody'))).toHaveLength(1);
    expect(resolveReadinessJudgeMode(loaded, {})).toBe('advisory');
  });

  it('reads readiness.judge: enforce without a warning', async () => {
    const { config: loaded, lines } = await load('readiness:\n  judge: enforce\n');
    expect(resolveReadinessJudgeMode(loaded, {})).toBe('enforce');
    expect(lines).toEqual([]);
  });

  it('rejects an unknown readiness.judge value, naming the key', async () => {
    await expect(load('readiness:\n  judge: strict\n')).rejects.toThrow(/readiness\.judge/);
  });
});
