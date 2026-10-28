// `factory run-brief a.md b.md --stack` (#3763): brief N+1 bases on brief N's PR head branch.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nextStackBase } from './run-brief.js';
import {
  errored,
  h,
  installShipHarness,
  logged,
  phases,
  runMainWith,
  setupWorktree,
} from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

function writeBrief(name: string): string {
  const path = join(h.repoRoot, `${name}.md`);
  writeFileSync(path, `# Add ${name}\n\nPlease add ${name}.\n\n## Acceptance criteria\n\n- ${name} exists\n`);
  return path;
}

const branches = () => setupWorktree.mock.calls.map((c) => c[1]);
const startPoints = () => setupWorktree.mock.calls.map((c) => c[3]);
const shipBases = () => phases.shipPhase.mock.calls.map((c) => (c[0] as any).baseBranch);

describe('nextStackBase (#3763)', () => {
  it('returns the PR head branch for a shipped/ready outcome with a PR', () => {
    const shipped = { state: 'shipped', branch: 'factory/9-a', prNumber: 4 } as any;
    const ready = { state: 'ready', branch: 'factory/9-b', prNumber: 5 } as any;
    expect(nextStackBase(shipped)).toEqual({ base: 'factory/9-a' });
    expect(nextStackBase(ready)).toEqual({ base: 'factory/9-b' });
  });

  it('returns a stop reason when the outcome has no PR', () => {
    expect(nextStackBase({ state: 'ready', branch: 'factory/9-a', prNumber: undefined } as any)).toEqual({
      stop: 'opened no PR',
    });
    expect(nextStackBase(undefined)).toEqual({ stop: 'opened no PR' });
  });
});

describe('run-brief --stack (#3763)', () => {
  it('without --stack every brief bases on the default branch', async () => {
    const res = await runMain('run-brief', writeBrief('alpha'), writeBrief('beta'));

    expect(res.exited).toBe(false);
    expect(startPoints()).toEqual([undefined, undefined]);
    expect(shipBases()).toEqual([undefined, undefined]);
  });

  it("--stack bases the second brief on the first brief's PR head", async () => {
    const a = writeBrief('alpha');
    const b = writeBrief('beta');

    const res = await runMain('run-brief', a, b, '--stack');

    expect(res.exited).toBe(false);
    const [first] = branches();
    expect(startPoints()).toEqual([undefined, `origin/${first}`]);
    expect(shipBases()).toEqual([undefined, first]);
    expect(logged()).toContain(`${b} → PR #99 (base ${first})`);
    expect(logged()).toContain('2/2 briefs succeeded');
  });

  it('--stack chains three briefs each on the previous head', async () => {
    const res = await runMain('run-brief', writeBrief('alpha'), writeBrief('beta'), writeBrief('gamma'), '--stack');

    expect(res.exited).toBe(false);
    const [one, two] = branches();
    expect(startPoints()).toEqual([undefined, `origin/${one}`, `origin/${two}`]);
    expect(shipBases()).toEqual([undefined, one, two]);
  });

  it('--stack starts the first brief from --base-branch', async () => {
    const res = await runMain(
      'run-brief',
      writeBrief('alpha'),
      writeBrief('beta'),
      '--stack',
      '--base-branch',
      'feat/x',
    );

    expect(res.exited).toBe(false);
    const [first] = branches();
    expect(startPoints()).toEqual(['origin/feat/x', `origin/${first}`]);
  });

  it('--stack stops and skips later briefs when a brief fails', async () => {
    const a = writeBrief('alpha');
    const b = writeBrief('beta');
    phases.checkPhase.mockResolvedValueOnce({
      passed: false,
      summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
      reworkRounds: 0,
    } as any);

    const res = await runMain('run-brief', a, b, '--stack');

    expect(res).toEqual({ exited: true, code: 1 });
    expect(phases.planPhase).toHaveBeenCalledTimes(1);
    expect(logged()).toContain(`${b} → skipped: stack stopped: ${a} failed`);
    expect(logged()).toContain('0/2 briefs succeeded');
    expect(errored()).toContain('Run failed for one or more briefs');
  });

  it('--stack stops after the first brief under --no-pr', async () => {
    const a = writeBrief('alpha');
    const b = writeBrief('beta');

    const res = await runMain('run-brief', a, b, '--stack', '--no-pr');

    expect(res).toEqual({ exited: true, code: 1 });
    expect(phases.checkPhase).toHaveBeenCalledTimes(1);
    expect(phases.shipPhase).not.toHaveBeenCalled();
    expect(logged()).toContain(`skipped: stack stopped: ${a} opened no PR`);
  });

  it('--stack with --workspace exits 2 before any brief runs', async () => {
    const res = await runMain(
      'run-brief',
      writeBrief('alpha'),
      writeBrief('beta'),
      '--stack',
      '--workspace',
      h.repoRoot,
    );

    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--stack needs factory worktrees and PRs');
    expect(phases.planPhase).not.toHaveBeenCalled();
  });
});
