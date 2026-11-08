import { describe, expect, it, vi } from 'vitest';

import {
  assertVisualProofForHead,
  attachVisualProof,
  publishVisualProof,
  renderVisualProofBlock,
  VISUAL_PROOF_START,
  VISUAL_PROOF_STATUS_CONTEXT,
  VisualProofMissingError,
} from './visual-proof-attach.js';
import type { VisualProofResult } from './visual-proof.js';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const target = { owner: 'o', repo: 'r', prNumber: 7, branch: 'feat/ui' };
const passResult: VisualProofResult = {
  status: 'pass',
  headSha: HEAD,
  runId: 'run-9',
  outDir: '/tmp/secret-local/out',
  captures: [
    {
      route: '/settings',
      state: 'default',
      viewport: { width: 1280, height: 800 },
      finalPath: '/settings',
      file: '0.png',
      bytes: 4,
    },
  ],
};

const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

function fakeOctokit(opts: { ref?: 'none' | 'exists'; readBack?: 'ok' | 'missing'; updateFails?: number } = {}) {
  let updateFails = opts.updateFails ?? 0;
  const git = {
    getRef: vi.fn(async () => {
      if (opts.ref !== 'exists') throw httpError(404);
      return { data: { object: { sha: 'parentsha' } } };
    }),
    getCommit: vi.fn(async () => ({ data: { tree: { sha: 'parenttree' } } })),
    createBlob: vi.fn(async () => ({ data: { sha: 'blobsha' } })),
    createTree: vi.fn(async () => ({ data: { sha: 'treesha' } })),
    createCommit: vi.fn(async () => ({ data: { sha: 'commitsha000000' } })),
    createRef: vi.fn(async () => ({})),
    updateRef: vi.fn(async () => {
      if (updateFails-- > 0) throw httpError(422);
      return {};
    }),
  };
  const repos = {
    getContent: vi.fn(async () => {
      if (opts.readBack === 'missing') throw httpError(404);
      return { data: { type: 'file', size: 4 } };
    }),
    createCommitStatus: vi.fn(async (_args: { state: string; description: string }) => ({})),
    listCommitStatusesForRef: vi.fn(),
  };
  const pulls = {
    get: vi.fn(async () => ({ data: { body: 'Original body' } })),
    update: vi.fn(async (_args: { body: string }) => ({})),
  };
  const octokit: any = { rest: { git, repos, pulls } };
  return { octokit, git, repos, pulls };
}

const readFile = () => Buffer.from([1, 2, 3, 4]);

describe('attachVisualProof', () => {
  it('embeds an immutable evidence-branch image for a valid capture', async () => {
    const { octokit, git, repos } = fakeOctokit();
    const r = await attachVisualProof(octokit, target, passResult, readFile);
    expect(r.status).toBe('pass');
    expect(r.images).toEqual([
      {
        route: '/settings',
        state: 'default',
        viewport: { width: 1280, height: 800 },
        url: 'https://github.com/o/r/blob/commitsha000000/visual-proof/7/run-9/abcdef012345/0-settings-default-1280x800.png?raw=true',
      },
    ]);
    expect(git.createBlob).toHaveBeenCalledWith({ owner: 'o', repo: 'r', content: 'AQIDBA==', encoding: 'base64' });
    expect(git.createTree).toHaveBeenCalledWith(expect.not.objectContaining({ base_tree: expect.anything() }));
    expect(git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'visual proof for PR #7 at abcdef012345 (run run-9)', parents: [] }),
    );
    expect(git.createRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'refs/heads/factory-evidence' }));
    expect(repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ ref: 'commitsha000000' }));
  });

  it('builds on the existing evidence branch with a fast-forward update', async () => {
    const { octokit, git } = fakeOctokit({ ref: 'exists' });
    const r = await attachVisualProof(octokit, { ...target, evidenceBranch: 'proof' }, passResult, readFile);
    expect(r.status).toBe('pass');
    expect(git.createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: 'parenttree' }));
    expect(git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/proof', sha: 'commitsha000000', force: false }),
    );
  });

  it('retries once when the ref moved (422)', async () => {
    const { octokit, git } = fakeOctokit({ ref: 'exists', updateFails: 1 });
    expect((await attachVisualProof(octokit, target, passResult, readFile)).status).toBe('pass');
    expect(git.updateRef).toHaveBeenCalledTimes(2);
    expect(git.createBlob).toHaveBeenCalledTimes(1);
  });

  it('fails with an upload diagnostic when the ref keeps moving', async () => {
    const { octokit } = fakeOctokit({ ref: 'exists', updateFails: 2 });
    const r = await attachVisualProof(octokit, target, passResult, readFile);
    expect(r).toMatchObject({ status: 'fail', diagnostic: 'upload failed: http 422' });
    expect(r.images).toBeUndefined();
  });

  it('fails when the uploaded asset cannot be read back', async () => {
    const { octokit } = fakeOctokit({ readBack: 'missing' });
    const r = await attachVisualProof(octokit, target, passResult, readFile);
    expect(r.status).toBe('fail');
    expect(r.diagnostic).toContain('upload failed: http 404');
  });

  it('fails when the read-back asset is not the uploaded file', async () => {
    const { octokit, repos } = fakeOctokit();
    repos.getContent.mockResolvedValueOnce({ data: { type: 'file', size: 99 } });
    const r = await attachVisualProof(octokit, target, passResult, readFile);
    expect(r).toMatchObject({ status: 'fail', diagnostic: expect.stringContaining('embedded asset unavailable') });
  });

  it('writes only to the configured evidence branch, never the PR head branch', async () => {
    for (const t of [
      { ...target, branch: 'factory-evidence' },
      { ...target, branch: 'factory/12-x' },
    ]) {
      const { octokit, git } = fakeOctokit();
      const r = await attachVisualProof(octokit, t, passResult, readFile);
      expect(r.status).toBe('fail');
      expect(r.diagnostic).toContain('refusing to write visual proof');
      expect(git.createBlob).not.toHaveBeenCalled();
      expect(git.createRef).not.toHaveBeenCalled();
    }
  });

  it('fails when the capture directory is unknown', async () => {
    const { octokit } = fakeOctokit();
    const r = await attachVisualProof(octokit, target, { ...passResult, outDir: undefined }, readFile);
    expect(r.status).toBe('fail');
  });
});

describe('renderVisualProofBlock and publishVisualProof', () => {
  const withImages: VisualProofResult = {
    ...passResult,
    images: [
      {
        route: '/settings',
        state: 'default',
        viewport: { width: 1280, height: 800 },
        url: 'https://github.com/o/r/blob/c/p.png?raw=true',
      },
    ],
  };

  it('renders provenance and the image', () => {
    const block = renderVisualProofBlock(withImages);
    expect(block).toContain(VISUAL_PROOF_START);
    expect(block).toContain('**Result: pass** · run `run-9` · head `abcdef012345`');
    expect(block).toContain('- `/settings` · state `default` · 1280x800');
    expect(block).toContain('![/settings default at abcdef012345](https://github.com/o/r/blob/c/p.png?raw=true)');
  });

  it('never renders a local filesystem path as proof', () => {
    const block = renderVisualProofBlock(withImages);
    expect(block).not.toContain('/tmp/secret-local');
    expect(block).not.toContain('0.png');
    expect(block).not.toMatch(/artifact/i);
  });

  it('renders the diagnostic and remedy on failure', () => {
    const block = renderVisualProofBlock({
      status: 'unavailable',
      headSha: HEAD,
      runId: 'run-9',
      captures: [],
      diagnostic: 'no leased lane port',
    });
    expect(block).toContain('**Result: unavailable**');
    expect(block).toContain('- Diagnostic: no leased lane port');
    expect(block).toContain('- Remedy: ');
    expect(block).not.toContain('![');
  });

  it('upserts the body and stamps a success status on the head', async () => {
    const { octokit, pulls, repos } = fakeOctokit();
    await publishVisualProof(octokit, target, withImages);
    const body = pulls.update.mock.calls[0]?.[0].body;
    expect(body).toContain('Original body');
    expect(body).toContain(VISUAL_PROOF_START);
    expect(repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: HEAD, context: VISUAL_PROOF_STATUS_CONTEXT, state: 'success' }),
    );
  });

  it('stamps a failure status with a truncated diagnostic', async () => {
    const { octokit, repos } = fakeOctokit();
    await publishVisualProof(octokit, target, {
      status: 'fail',
      headSha: HEAD,
      runId: 'r',
      captures: [],
      diagnostic: 'x'.repeat(400),
    });
    const call = repos.createCommitStatus.mock.calls[0]?.[0];
    expect(call?.state).toBe('failure');
    expect(call?.description).toHaveLength(140);
  });

  it('does not rewrite an unchanged body', async () => {
    const { octokit, pulls } = fakeOctokit();
    const block = renderVisualProofBlock(withImages);
    pulls.get.mockResolvedValueOnce({ data: { body: block } });
    await publishVisualProof(octokit, target, withImages);
    expect(pulls.update).not.toHaveBeenCalled();
  });
});

describe('assertVisualProofForHead', () => {
  const marked = `body\n${VISUAL_PROOF_START}\nx`;
  const run = (prBody: string | null, statuses: object[], self = 5) => {
    const { octokit, repos } = fakeOctokit();
    repos.listCommitStatusesForRef.mockResolvedValue({ data: statuses });
    return {
      repos,
      result: assertVisualProofForHead(
        octokit,
        { owner: 'o', repo: 'r', prNumber: 7, prBody, headSha: HEAD },
        async () => self,
      ),
    };
  };
  const status = (state: string, id = 5, context = VISUAL_PROOF_STATUS_CONTEXT) => ({
    context,
    state,
    creator: { id },
  });

  it('returns without a lookup when the body has no marker', async () => {
    const { repos, result } = run('plain', []);
    await expect(result).resolves.toBeUndefined();
    await expect(run(null, []).result).resolves.toBeUndefined();
    expect(repos.listCommitStatusesForRef).not.toHaveBeenCalled();
  });

  it('throws with the remedy when the head has no status (proof for another sha)', async () => {
    const err = await run(marked, [status('success', 5, 'ci/other')]).result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VisualProofMissingError);
    expect((err as Error).message).toContain(
      're-run SHIP (factory resume --from ship) to capture proof for abcdef012345',
    );
  });

  it('throws when the newest status is pending or failure', async () => {
    await expect(run(marked, [status('pending'), status('success')]).result).rejects.toBeInstanceOf(
      VisualProofMissingError,
    );
    await expect(run(marked, [status('failure')]).result).rejects.toBeInstanceOf(VisualProofMissingError);
  });

  it('throws when the status was not created by the factory', async () => {
    await expect(run(marked, [status('success', 99)]).result).rejects.toBeInstanceOf(VisualProofMissingError);
  });

  it('passes for a factory-created success status', async () => {
    await expect(run(marked, [status('success')]).result).resolves.toBeUndefined();
  });
});
