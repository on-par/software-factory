// `factory run-brief <file> [file...]` (#3762): briefs run one after another in argv order with the same
// flags; a failed brief does not stop the rest, and the exit code is non-zero if any brief failed.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { errored, h, installShipHarness, logged, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

function writeBrief(name: string): string {
  const path = join(h.repoRoot, `${name}.md`);
  writeFileSync(path, `# Add ${name}\n\nPlease add ${name}.\n\n## Acceptance criteria\n\n- ${name} exists\n`);
  return path;
}

const planPaths = () => phases.planPhase.mock.calls.map((c) => (c[0] as any).workSource.params.path);

describe('run-brief with several briefs (#3762)', () => {
  it('runs two briefs in argv order and exits 0 with a per-brief summary', async () => {
    const b = writeBrief('beta');
    const a = writeBrief('alpha');

    const res = await runMain('run-brief', b, a);

    expect(res.exited).toBe(false);
    expect(planPaths()).toEqual([b, a]);
    expect(phases.shipPhase).toHaveBeenCalledTimes(2);
    const out = logged();
    expect(out).toContain(`[1/2] ${b}`);
    expect(out).toContain(`[2/2] ${a}`);
    expect(out.indexOf(`[1/2] ${b}`)).toBeLessThan(out.indexOf(`[2/2] ${a}`));
    expect(out).toContain(`${b} → PR #99`);
    expect(out).toContain(`${a} → PR #99`);
    expect(out).toContain('2/2 briefs succeeded');
  });

  it('keeps going after a pipeline failure in the first brief and exits 1', async () => {
    const a = writeBrief('alpha');
    const b = writeBrief('beta');
    phases.checkPhase.mockResolvedValueOnce({
      passed: false,
      summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
      reworkRounds: 0,
    } as any);

    const res = await runMain('run-brief', a, b);

    expect(res).toEqual({ exited: true, code: 1 });
    expect(planPaths()).toEqual([a, b]);
    expect(phases.shipPhase).toHaveBeenCalledTimes(1);
    expect(logged()).toContain(`${a} → failed: Run failed for brief ${a}`);
    expect(logged()).toContain(`${b} → PR #99`);
    expect(logged()).toContain('1/2 briefs succeeded');
    expect(errored()).toContain('Run failed for one or more briefs');
  });

  it.each([
    ['a missing file', (dir: string) => join(dir, 'does-not-exist.md'), 'could not resolve brief'],
    ['an empty path', () => '', 'expected { path: "path/to/brief.md" }'],
  ])('fails %s, still runs the next brief, and exits 1', async (_label, badPath, message) => {
    const bad = badPath(h.repoRoot);
    const good = writeBrief('alpha');

    const res = await runMain('run-brief', bad, good);

    expect(res).toEqual({ exited: true, code: 1 });
    expect(planPaths()).toEqual([good]);
    expect(logged()).toContain(`${bad} → failed`);
    expect(logged()).toContain(message);
    expect(logged()).toContain(`${good} → PR #99`);
    expect(logged()).toContain('1/2 briefs succeeded');
  });

  it('passes the same flags to every brief', async () => {
    const branches: string[] = [];
    h.setupWorktreeImpl = async (_repo, branch) => {
      branches.push(branch);
    };
    const a = writeBrief('alpha');
    const b = writeBrief('beta');

    const res = await runMain('run-brief', a, b, '--draft-pr', '--branch-prefix', 'sf');

    expect(res.exited).toBe(false);
    expect(branches).toHaveLength(2);
    expect(branches.every((br) => br.startsWith('sf/'))).toBe(true);
    expect(phases.shipPhase.mock.calls.map((c) => (c[0] as any).draft)).toEqual([true, true]);
  });

  it('--no-pr stops every brief after CHECK', async () => {
    const res = await runMain('run-brief', writeBrief('alpha'), writeBrief('beta'), '--no-pr');

    expect(res.exited).toBe(false);
    expect(phases.checkPhase).toHaveBeenCalledTimes(2);
    expect(phases.shipPhase).not.toHaveBeenCalled();
  });

  it('rejects --artifacts with more than one brief before any run', async () => {
    const res = await runMain('run-brief', writeBrief('alpha'), writeBrief('beta'), '--artifacts', h.repoRoot);

    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--artifacts takes exactly one brief');
    expect(phases.planPhase).not.toHaveBeenCalled();
  });

  it('is a usage error with no brief file', async () => {
    const res = await runMain('run-brief');

    expect(res.exited).toBe(true);
    expect(res.code).not.toBe(0);
    expect(phases.planPhase).not.toHaveBeenCalled();
  });
});
