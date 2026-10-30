import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  coreFakes,
  errored,
  h,
  installCliCommandsHarness,
  logged,
  paths,
  runMain,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('triage', () => {
    it('triage exits 2 with gh auth login guidance when gh is not authenticated (#2592)', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) {
          throw Object.assign(new Error('Command failed: gh repo view'), {
            stderr:
              'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
          });
        }
        return '';
      };
      const res = await runMain('triage');
      expect(res).toMatchObject({ exited: true, code: 2 });
      expect(errored()).toContain('gh is not authenticated');
      expect(errored()).toContain('gh auth login');
      expect(errored()).not.toContain('no GitHub remote detected');
    });

    const ghIssues = JSON.stringify([
      { number: 5, title: 'Five', labels: [{ name: 'bug' }], body: 'x'.repeat(10_000) },
      { number: 6, title: 'Six', labels: [], body: 'short' },
    ]);
    const execWithIssues = (cmd: string) => {
      if (cmd.includes('rev-parse')) return h.repoRoot;
      if (cmd.includes('gh repo view')) return h.ghRepo;
      if (cmd.includes('gh issue list')) return ghIssues;
      return '';
    };

    it('dispatches through the router, never spawns claude -p, and writes a valid proposal (#1650)', async () => {
      const cmds: string[] = [];
      h.execImpl = (cmd: string) => {
        cmds.push(cmd);
        return execWithIssues(cmd);
      };
      let seenPrompt = '';
      h.routerRun = async (task, prompt) => {
        expect(task).toBe('triage');
        seenPrompt = prompt;
        return { model: 'gpt-5.6-luna-high', output: '```\n# header\n\napp 5\napp #6\n```\n' };
      };
      await runMain('triage');
      expect(cmds.some((c) => c.includes('claude -p'))).toBe(false);
      expect(seenPrompt).toContain('#5: Five [labels: bug]');
      expect(seenPrompt).not.toContain('x'.repeat(1_500));
      const proposed = readFileSync(paths().queueProposed, 'utf-8');
      expect(proposed).toBe('# Triage queue (model gpt-5.6-luna-high)\n# header\napp 5\napp 6\n');
      expect(logged()).toContain('factory triage accept');
      expect(readFileSync(paths().events, 'utf-8')).toContain('with gpt-5.6-luna-high');
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('2 issue(s) promoted');
    });

    it('triage sets the router codex sandbox from config (#3830)', async () => {
      h.execImpl = execWithIssues;
      h.factoryConfig = {
        ...h.factoryConfig,
        sandbox: { ...h.factoryConfig.sandbox, codexSandbox: 'workspace-write' },
      };
      h.routerRun = async () => ({ model: 'gpt-5.6-terra-high', output: 'app 5\n' });
      await runMain('triage');
      expect(vi.mocked(coreFakes.ModelRouter).mock.results.at(-1)?.value.setCodexSandbox).toHaveBeenCalledWith(
        'workspace-write',
      );
    });

    it('passes --model to the router as the model override', async () => {
      h.execImpl = execWithIssues;
      let seenOpts: any;
      h.routerRun = async (_task, _prompt, opts) => {
        seenOpts = opts;
        return { model: 'gpt-5.6-terra-high', output: 'app 5\n' };
      };
      await runMain('triage', '--model', 'gpt-5.6-terra-high');
      expect(seenOpts.modelOverride).toBe('gpt-5.6-terra-high');
    });

    it('exits 1 when triage produces no proposal', async () => {
      h.execImpl = execWithIssues;
      h.routerRun = async () => ({ model: 'm', output: 'I could not decide.' });
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no proposal');
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('logs the planner failure detail and exits 1 with no proposal when the router fails', async () => {
      h.execImpl = execWithIssues;
      h.routerRun = async () => {
        throw new Error('codex crashed');
      };
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no proposal');
      expect(errored()).toContain('codex crashed');
      expect(readFileSync(paths().events, 'utf-8')).toContain('triage planner failed');
    });
  });

  describe('triage accept', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
    });

    it('accepts a valid proposed queue', async () => {
      writeFileSync(paths().queueProposed, 'app 5\napp 6\n');
      await runMain('triage', 'accept');
      expect(existsSync(paths().queueProposed)).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 5\napp 6\n');
      expect(logged()).toContain('queue accepted');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('"type":"triage_accepted"');
      expect(events).toContain('5, 6');
    });

    it('accepts a proposal with a header, comments and a blank line before the first entry', async () => {
      const body = '# Triage queue — constitution: default-code\n# c1\n# c2\n# c3\n# c4\n\ngreet 1\n';
      writeFileSync(paths().queueProposed, body);
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe(body);
      expect(logged()).toContain('queue accepted');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('"type":"triage_accepted"');
      expect(events).toContain('1');
    });

    it('rejects an invalid queue and leaves it unchanged', async () => {
      writeFileSync(paths().queueProposed, 'app 5\napp notanumber\n');
      const res = await runMain('triage', 'accept');
      expect(res).toEqual({ exited: true, code: 1 });
      const err = errored();
      expect(err).toContain('invalid');
      expect(err).toContain('malformed');
      expect(existsSync(paths().queueProposed)).toBe(true);
      expect(readFileSync(paths().queueProposed, 'utf-8')).toBe('app 5\napp notanumber\n');
      expect(existsSync(paths().queue)).toBe(false);
    });

    it('reports nothing to accept when there is no proposed queue', async () => {
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('nothing to accept');
    });

    it('--force skips validation and promotes as-is', async () => {
      writeFileSync(paths().queueProposed, 'app notanumber\n');
      await runMain('triage', 'accept', '--force');
      expect(existsSync(paths().queueProposed)).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app notanumber\n');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('triage_accepted');
      expect(events).toContain('--force');
    });
  });
});
