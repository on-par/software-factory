import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFactoryConfigForRepo, loadModelsConfig, loadRoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { ExecFn } from '../utils/exec.js';
import {
  contextCeilingFor,
  contextCeilingNotice,
  formatContextCeilingNotice,
  type ContextCeilingNotice,
} from './context-ceiling.js';
import { CliModelExecutor, type ModelExecutor, type ModelExecutorContext, ModelRouter } from './index.js';

const fakeGitExec: ExecFn = async () => ({ stdout: '', stderr: '' });

let tmp: string;
const tempDirs = createTempDirs();
beforeEach(async () => {
  tmp = await tempDirs.make('ctx-ceiling-');
});
afterEach(() => tempDirs.cleanup());

async function configFor(build?: unknown) {
  await mkdir(join(tmp, '.factory'), { recursive: true });
  const path = join(tmp, '.factory', 'config.json');
  await writeFile(path, JSON.stringify(build === undefined ? {} : { build }));
  return loadFactoryConfigForRepo(path);
}

interface Seen {
  ctxs: ModelExecutorContext[];
  notices: ContextCeilingNotice[];
}

async function runTask(task: 'build_codex' | 'build_claude' | 'plan', build?: unknown, failFirst = false) {
  const cfg = await configFor(build);
  const seen: Seen = { ctxs: [], notices: [] };
  let calls = 0;
  const executor: ModelExecutor = {
    async runModel(_model, _prompt, ctx) {
      seen.ctxs.push(ctx);
      if (failFirst && calls++ === 0) throw new Error('boom');
      return 'ok';
    },
  };
  const router = new ModelRouter(loadModelsConfig(), loadRoutesConfig(), false, executor, false, false, fakeGitExec);
  router.setContextCeilings(cfg.build.contextCeiling);
  await router.run(task, 'x', { worktree: tmp, onContextCeiling: (n) => seen.notices.push(n) });
  return seen;
}

/** Runs the recorded ctx through the real CliModelExecutor and returns the codex command. */
async function codexCommand(ctx: ModelExecutorContext, model: string): Promise<string> {
  let cmd = '';
  const exec: ExecFn = async (c) => {
    cmd = c;
    const out = c.match(/-o '([^']+)'/)?.[1];
    if (out) await writeFile(out, 'OUT');
    return { stdout: '', stderr: '' };
  };
  await new CliModelExecutor(exec).runModel(model, 'x', ctx);
  return cmd;
}

describe('build.contextCeiling reaches the harness request', () => {
  it('repo build.contextCeiling reaches the Codex BUILD request', async () => {
    const seen = await runTask('build_codex', { contextCeiling: { 'codex-cli': 90000 } });
    expect(seen.ctxs[0].contextCeiling).toBe(90000);
    expect(seen.notices).toHaveLength(1);
    expect(formatContextCeilingNotice(seen.notices[0])).toContain('90000');
    const cmd = await codexCommand(seen.ctxs[0], seen.notices[0].model);
    expect(cmd).toContain('model_auto_compact_token_limit=90000');
  });

  it('no build.contextCeiling gives the Codex BUILD request 120000', async () => {
    const seen = await runTask('build_codex');
    expect(seen.ctxs[0].contextCeiling).toBe(120000);
    expect(formatContextCeilingNotice(seen.notices[0])).toContain('120000');
  });

  it('codex-cli 0 reaches the harness with no compaction flag and the event says off (config)', async () => {
    const seen = await runTask('build_codex', { contextCeiling: { 'codex-cli': 0 } });
    expect(seen.ctxs[0].contextCeiling).toBe(0);
    expect(formatContextCeilingNotice(seen.notices[0])).toContain('off (config)');
    const cmd = await codexCommand(seen.ctxs[0], seen.notices[0].model);
    expect(cmd).not.toContain('model_auto_compact_token_limit');
  });

  it('a PLAN run gets no ceiling and no notice', async () => {
    const seen = await runTask('plan');
    expect(seen.ctxs[0].contextCeiling).toBeUndefined();
    expect(seen.notices).toEqual([]);
  });

  it('a build_claude run gets no ceiling and an unsupported notice', async () => {
    const seen = await runTask('build_claude');
    expect(seen.ctxs[0].contextCeiling).toBeUndefined();
    expect(formatContextCeilingNotice(seen.notices[0])).toContain('off (unsupported by claude-cli)');
  });

  it('logs one notice per run even when the first attempt is retried', async () => {
    const seen = await runTask('build_codex', undefined, true);
    expect(seen.ctxs.length).toBeGreaterThan(1);
    expect(seen.notices).toHaveLength(1);
  });
});

describe('context ceiling helpers', () => {
  const ceilings = { 'codex-cli': 90000, 'claude-cli': 5 };

  it('contextCeilingFor only returns a value for agentic tasks on honouring harnesses', () => {
    expect(contextCeilingFor('build_codex', 'codex-cli', ceilings)).toBe(90000);
    expect(contextCeilingFor('plan', 'codex-cli', ceilings)).toBeUndefined();
    expect(contextCeilingFor('build_claude', 'claude-cli', ceilings)).toBeUndefined();
    expect(contextCeilingFor('build_codex', undefined, ceilings)).toBeUndefined();
    expect(contextCeilingFor('build_codex', 'codex-cli', {})).toBeUndefined();
  });

  it('contextCeilingNotice reports value, window guard and unknown harness', () => {
    expect(contextCeilingNotice('build_codex', 'm', 'codex-cli', ceilings, 272000)).toMatchObject({ value: 90000 });
    expect(contextCeilingNotice('build_codex', 'm', 'codex-cli', { 'codex-cli': 300000 }, 272000)).toMatchObject({
      off: 'ceiling 300000 >= context window 272000',
    });
    expect(contextCeilingNotice('build_codex', 'm', undefined, ceilings, undefined)).toMatchObject({
      harness: 'unknown',
      off: 'unsupported by unknown',
    });
    expect(contextCeilingNotice('build_codex', 'm', 'codex-cli', {}, undefined)).toMatchObject({ value: 120000 });
  });

  it('formatContextCeilingNotice renders both shapes', () => {
    const base = { task: 'build_codex', model: 'm', harness: 'codex-cli' } as const;
    expect(formatContextCeilingNotice({ ...base, value: 5 })).toBe('context ceiling 5 for build_codex (codex-cli, m)');
    expect(formatContextCeilingNotice({ ...base, off: 'config' })).toBe(
      'context ceiling off (config) for build_codex (codex-cli, m)',
    );
  });
});
