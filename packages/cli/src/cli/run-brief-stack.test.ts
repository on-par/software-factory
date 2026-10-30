// `factory run-brief a.md b.md --stack` (#3763): brief N+1 bases on brief N's PR head branch.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fileSlicePlanStore, nextStackSlice, withSliceState, type SlicePlan } from '@on-par/factory-core/internal';

import {
  errored,
  h,
  installShipHarness,
  logged,
  paths,
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

const story = (n: number) => ({
  schemaVersion: 1 as const,
  kind: 'story' as const,
  filesLikelyTouched: [],
  labels: [],
  title: `Story ${n}`,
  role: 'operator',
  want: `thing ${n} works`,
  soThat: 'value',
  problemStatement: `Problem ${n}`,
  inScope: [`Scope ${n}`],
  outOfScope: ['Persistent storage'],
  acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
  verification: [{ command: 'npm test', passWhen: 'passes' }],
  tracesTo: ['INT-PROBLEM-01'],
});
const threeSlices = (issue: number): SlicePlan => ({
  issue,
  slices: [1, 2, 3].map((n) => ({ index: n, title: `S${n}`, story: story(n) as never, state: 'pending' as const })),
});

/** planPhase double: with no stored plan it slices the brief into three (saving the plan to the injected
 *  store); with one it plans the lowest pending slice, as the real pre-PLAN stack gate does. */
/** Worktrees are real git repos so core's slice-branch checkout works; every branch and start point gets an origin ref. */
function realGitWorktrees(): void {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
  const known = new Set<string>(['origin/main']);
  h.setupWorktreeImpl = async (_repoRoot, branch, worktree, startPoint) => {
    mkdirSync(worktree, { recursive: true });
    if (!existsSync(join(worktree, '.git'))) {
      git(worktree, 'init', '-q');
      git(worktree, 'commit', '-q', '--allow-empty', '-m', 'init');
    }
    known.add(`origin/${branch}`);
    if (startPoint !== undefined) known.add(startPoint);
    for (const ref of known) {
      git(worktree, 'update-ref', `refs/remotes/${ref}`, 'HEAD');
      git(worktree, 'update-ref', `refs/heads/${ref.replace(/^origin\//, '')}`, 'HEAD');
    }
  };
}

function fakeSlicingPlan(seed?: (issue: number) => SlicePlan) {
  phases.planPhase.mockImplementation(async (opts: any) => {
    const store = opts.slicePlanStore;
    const issue = Number(opts.issue);
    const found = await store.find();
    if (found.status === 'not-found') {
      await store.save(seed ? seed(issue) : threeSlices(issue));
      return {
        ok: false,
        route: 'claude',
        specPath: opts.specPath,
        model: '',
        escalate: 'plan scope exceeds the bounded-build budget — sliced into 3 slice(s)',
        designArtifact: null,
        sliced: { sliceCount: 3 },
      } as any;
    }
    const next = nextStackSlice(found.plan);
    return { ok: true, route: 'claude', slice: { plan: found.plan, index: next!.index } } as any;
  });
}

describe('run-brief <file> --stack with a single brief (#3813)', () => {
  it("a single oversized brief with --stack slices it and builds every slice on the previous slice's PR head", async () => {
    realGitWorktrees();
    fakeSlicingPlan();
    const res = await runMain('run-brief', writeBrief('big'), '--stack');
    expect(errored()).toBe('');

    expect(res.exited).toBe(false);
    const sizes = phases.planPhase.mock.calls.map((c) => (c[0] as any).sizeGateMode);
    expect(sizes).toEqual(['stack', 'stack', 'stack', 'stack']);
    const stores = phases.planPhase.mock.calls.map((c) => (c[0] as any).slicePlanStore);
    expect(new Set(stores).size).toBe(1);
    expect(stores[0]).toBeDefined();
    const ships = phases.shipPhase.mock.calls.map((c) => c[0] as any);
    expect(ships.map((o) => o.branch)).toEqual([1, 2, 3].map((k) => expect.stringMatching(new RegExp(`-slice-${k}$`))));
    expect(ships.map((o) => o.stack.base)).toEqual(['main', ships[0].branch, ships[1].branch]);
    expect(existsSync(join(paths().state, 'slice-plans'))).toBe(true);
    expect(logged()).toContain('run-brief: --stack — sizing');
    expect(logged()).toContain('3/3 slices succeeded');
    expect(errored()).toBe('');
  });

  it('a re-run of a stacked brief reads the stored slice plan and builds only pending slices', async () => {
    const file = writeBrief('big');
    realGitWorktrees();
    fakeSlicingPlan();
    await runMain('run-brief', file, '--stack');
    const [dir] = [join(paths().state, 'slice-plans')];
    const planFile = join(dir, readdirSync(dir)[0]!);
    const store = fileSlicePlanStore(planFile);
    const stored = await store.find();
    if (stored.status !== 'found') throw new Error('plan missing');
    await store.save(withSliceState(threeSlices(stored.plan.issue), 1, 'pr-open', 101, 'factory/slice-1'));
    phases.planPhase.mockClear();
    setupWorktree.mockClear();
    phases.shipPhase.mockClear();

    const res = await runMain('run-brief', file, '--stack');

    expect(errored()).toBe('');
    expect(res.exited).toBe(false);
    expect(phases.planPhase).toHaveBeenCalledTimes(2);
    const ships = phases.shipPhase.mock.calls.map((c) => c[0] as any);
    expect(ships.map((o) => o.stack.index)).toEqual([2, 3]);
    expect(ships[0].stack.base).toBe('factory/slice-1');
    expect(logged()).toContain('building 2 in order');
  });

  it('several briefs with --stack keep one brief per slice with the size gate off and no slice-plan store', async () => {
    await runMain('run-brief', writeBrief('alpha'), writeBrief('beta'), '--stack');

    for (const call of phases.planPhase.mock.calls) {
      expect((call[0] as any).sizeGateMode).toBe('off');
      expect((call[0] as any).slicePlanStore).toBeUndefined();
    }
    expect(phases.planPhase).toHaveBeenCalledTimes(2);
  });
});
