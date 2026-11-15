import { describe, expect, it } from 'vitest';

import {
  assertVisualProofForHead,
  attachVisualProof,
  publishVisualProof,
  renderVisualProofBlock,
  VISUAL_PROOF_ADVISORY_START,
  VISUAL_PROOF_END,
  VISUAL_PROOF_START,
  VISUAL_PROOF_STATUS_CONTEXT,
  VisualProofMissingError,
} from './visual-proof-attach.js';
import { fakeOctokit } from '../test-support/fake-octokit.js';
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

const readFile = () => Buffer.from([1, 2, 3, 4]);

describe('attachVisualProof', () => {
  it('embeds an immutable evidence-branch image for a valid capture', async () => {
    const { octokit, calls } = fakeOctokit();
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
    expect(calls.createBlob).toEqual([{ owner: 'o', repo: 'r', content: 'AQIDBA==', encoding: 'base64' }]);
    expect(calls.createTree[0]).not.toHaveProperty('base_tree');
    expect(calls.createCommit[0]).toMatchObject({
      message: 'visual proof for PR #7 at abcdef012345 (run run-9)',
      parents: [],
    });
    expect(calls.createRef[0]).toMatchObject({ ref: 'refs/heads/factory-evidence' });
    expect(calls.getContent[0]).toMatchObject({ ref: 'commitsha000000' });
  });

  it('builds on the existing evidence branch with a fast-forward update', async () => {
    const { octokit, calls } = fakeOctokit({ ref: 'exists' });
    const r = await attachVisualProof(octokit, { ...target, evidenceBranch: 'proof' }, passResult, readFile);
    expect(r.status).toBe('pass');
    expect(calls.createTree[0]).toMatchObject({ base_tree: 'parenttree' });
    expect(calls.updateRef[0]).toMatchObject({ ref: 'heads/proof', sha: 'commitsha000000', force: false });
  });

  it('retries once when the ref moved (422)', async () => {
    const { octokit, calls } = fakeOctokit({ ref: 'exists', updateFails: 1 });
    expect((await attachVisualProof(octokit, target, passResult, readFile)).status).toBe('pass');
    expect(calls.updateRef).toHaveLength(2);
    expect(calls.createBlob).toHaveLength(1);
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
    const { octokit } = fakeOctokit({ readBackSize: 99 });
    const r = await attachVisualProof(octokit, target, passResult, readFile);
    expect(r).toMatchObject({ status: 'fail', diagnostic: expect.stringContaining('embedded asset unavailable') });
  });

  it('uploads proof for a factory/* PR head branch to the default evidence branch', async () => {
    const { octokit, calls } = fakeOctokit();
    const r = await attachVisualProof(octokit, { ...target, branch: 'factory/12-x' }, passResult, readFile);
    expect(r.status).toBe('pass');
    expect(r.images?.[0]?.url).toBe(
      'https://github.com/o/r/blob/commitsha000000/visual-proof/7/run-9/abcdef012345/0-settings-default-1280x800.png?raw=true',
    );
    expect(calls.createRef[0]).toMatchObject({ ref: 'refs/heads/factory-evidence' });
    expect(r.diagnostic).toBeUndefined();
  });

  it('refuses an evidence branch equal to the PR head branch', async () => {
    for (const t of [
      { ...target, branch: 'factory-evidence' },
      { ...target, branch: 'proof', evidenceBranch: 'proof' },
    ]) {
      const { octokit, calls } = fakeOctokit();
      const r = await attachVisualProof(octokit, t, passResult, readFile);
      expect(r.status).toBe('fail');
      expect(r.diagnostic).toContain('refusing to write visual proof to the PR branch');
      expect(calls.createBlob).toEqual([]);
      expect(calls.createRef).toEqual([]);
      expect(calls.updateRef).toEqual([]);
    }
  });

  it('refuses a factory/* evidence branch', async () => {
    const { octokit, calls } = fakeOctokit();
    const r = await attachVisualProof(octokit, { ...target, evidenceBranch: 'factory/proof' }, passResult, readFile);
    expect(r.status).toBe('fail');
    expect(r.diagnostic).toContain('factory/proof');
    expect(r.diagnostic).not.toContain('PR branch feat/ui');
    expect(calls.createBlob).toEqual([]);
    expect(calls.createRef).toEqual([]);
    expect(calls.updateRef).toEqual([]);
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
    const { octokit, calls } = fakeOctokit();
    await publishVisualProof(octokit, target, withImages);
    const body = calls.pullsUpdate[0]?.body;
    expect(body).toContain('Original body');
    expect(body).toContain(VISUAL_PROOF_START);
    expect(calls.createCommitStatus[0]).toMatchObject({
      sha: HEAD,
      context: VISUAL_PROOF_STATUS_CONTEXT,
      state: 'success',
    });
  });

  it('stamps a failure status with a truncated diagnostic', async () => {
    const { octokit, calls } = fakeOctokit();
    await publishVisualProof(octokit, target, {
      status: 'fail',
      headSha: HEAD,
      runId: 'r',
      captures: [],
      diagnostic: 'x'.repeat(400),
    });
    const call = calls.createCommitStatus[0];
    expect(call?.state).toBe('failure');
    expect(call?.description).toHaveLength(140);
  });

  const failed: VisualProofResult = {
    status: 'fail',
    headSha: HEAD,
    runId: 'r',
    captures: [],
    diagnostic: 'capture exited 1',
  };
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it('renders an advisory block with its own start marker and an advisory note (#4047)', () => {
    const block = renderVisualProofBlock(failed, 'advisory');
    expect(block.startsWith(VISUAL_PROOF_ADVISORY_START)).toBe(true);
    expect(block).not.toContain(VISUAL_PROOF_START);
    expect(block.endsWith(VISUAL_PROOF_END)).toBe(true);
    expect(block).toContain('**Result: fail** (advisory)');
    expect(block).toContain('does not block SHIP or merge');
    expect(block).toContain('- Diagnostic: capture exited 1');
  });

  it('stamps success with an advisory description for an advisory non-pass, so required-check readers never see red nor wait forever on an unreported status (#4047)', async () => {
    const { octokit, calls } = fakeOctokit();
    await publishVisualProof(octokit, target, failed, 'advisory');
    expect(calls.pullsUpdate[0]?.body).toContain(VISUAL_PROOF_ADVISORY_START);
    expect(calls.createCommitStatus[0]).toMatchObject({
      context: VISUAL_PROOF_STATUS_CONTEXT,
      state: 'success',
      description: 'advisory: visual proof fail: capture exited 1',
    });
  });

  it('replaces a required block with the advisory one in place, and back, so switching modes never leaves two blocks (#4047)', async () => {
    const required = `Intro\n\n${renderVisualProofBlock(failed)}\n\nOutro`;
    const prBodies = [required];
    const { octokit, calls } = fakeOctokit({ prBodies });
    await publishVisualProof(octokit, target, failed, 'advisory');
    const advisoryBody = calls.pullsUpdate[0]?.body ?? '';
    expect(advisoryBody).not.toContain(VISUAL_PROOF_START);
    expect(count(advisoryBody, VISUAL_PROOF_ADVISORY_START)).toBe(1);
    expect(count(advisoryBody, VISUAL_PROOF_END)).toBe(1);
    expect(advisoryBody.indexOf('Intro')).toBeLessThan(advisoryBody.indexOf(VISUAL_PROOF_ADVISORY_START));
    expect(advisoryBody.indexOf(VISUAL_PROOF_END)).toBeLessThan(advisoryBody.indexOf('Outro'));

    prBodies.push(`${advisoryBody}\n\n${renderVisualProofBlock(failed)}`);
    await publishVisualProof(octokit, target, withImages);
    const requiredBody = calls.pullsUpdate[1]?.body ?? '';
    expect(requiredBody).not.toContain(VISUAL_PROOF_ADVISORY_START);
    expect(count(requiredBody, VISUAL_PROOF_START)).toBe(1);
    expect(count(requiredBody, VISUAL_PROOF_END)).toBe(1);
  });

  it('does not rewrite an unchanged body', async () => {
    const block = renderVisualProofBlock(withImages);
    const { octokit, calls } = fakeOctokit({ prBodies: [block] });
    await publishVisualProof(octokit, target, withImages);
    expect(calls.pullsUpdate).toEqual([]);
  });
});

describe('assertVisualProofForHead', () => {
  const marked = `body\n${VISUAL_PROOF_START}\nx`;
  const run = (prBody: string | null, statuses: object[], self = 5) => {
    const { octokit, calls } = fakeOctokit({ statuses });
    return {
      calls,
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

  it('returns without a lookup when the body has no marker, since land enforces proof only under the required marker', async () => {
    const { calls, result } = run('plain', []);
    await expect(result).resolves.toBeUndefined();
    await expect(run(null, []).result).resolves.toBeUndefined();
    expect(calls.listCommitStatusesForRef).toEqual([]);
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

  it('does not enforce an advisory block (#4047)', async () => {
    const { calls, result } = run(`body\n${VISUAL_PROOF_ADVISORY_START}\nx\n${VISUAL_PROOF_END}`, [status('failure')]);
    await expect(result).resolves.toBeUndefined();
    expect(calls.listCommitStatusesForRef).toEqual([]);
  });

  it('passes for a factory-created success status', async () => {
    await expect(run(marked, [status('success')]).result).resolves.toBeUndefined();
  });
});

describe('stateful visual proof (#4054)', () => {
  const steps = [{ click: '#new' }, { fill: '#name', value: 'Demo' }, { press: 'Enter' }];
  const statefulCapture = (clip?: { file: string; format: 'gif' | 'webm' | 'mp4'; bytes: number }) => ({
    route: '/items',
    state: 'item-created',
    viewport: { width: 1280, height: 800 },
    finalPath: '/items',
    file: 'after.png',
    bytes: 4,
    before: { file: 'before.png', finalPath: '/items', bytes: 4 },
    steps,
    ...(clip ? { clip } : {}),
  });
  const statefulResult = (clip?: {
    file: string;
    format: 'gif' | 'webm' | 'mp4';
    bytes: number;
  }): VisualProofResult => ({
    ...passResult,
    captures: [statefulCapture(clip)],
  });

  it('uploads before, after and clip and embeds a gif or links a video', async () => {
    for (const format of ['gif', 'webm'] as const) {
      const { octokit } = fakeOctokit();
      const uploaded: string[] = [];
      const readBack: string[] = [];
      let commits = 0;
      octokit.rest.git.createBlob = async (args: { content: string }) => {
        uploaded.push(args.content);
        return { data: { sha: 'blobsha' } };
      };
      octokit.rest.git.createCommit = async () => {
        commits += 1;
        return { data: { sha: 'commitsha000000' } };
      };
      octokit.rest.repos.getContent = async (args: { path: string }) => {
        readBack.push(args.path);
        return { data: { type: 'file', size: 4 } };
      };
      const r = await attachVisualProof(
        octokit,
        target,
        statefulResult({ file: `clip.${format}`, format, bytes: 4 }),
        readFile,
      );
      expect(r.status).toBe('pass');
      expect(uploaded).toHaveLength(3);
      expect(readBack).toEqual([
        expect.stringMatching(/\/0-items-item-created-1280x800\.png$/),
        expect.stringMatching(/\/0-items-item-created-before-1280x800\.png$/),
        expect.stringMatching(new RegExp(`/0-items-item-created-clip\\.${format}$`)),
      ]);
      expect(commits).toBe(1);
      const image = r.images?.[0];
      expect(image?.beforeUrl).toContain('before-1280x800.png?raw=true');
      expect(image?.clipUrl).toContain(`clip.${format}?raw=true`);
      expect(image?.clipFormat).toBe(format);
      expect(image?.steps).toEqual(steps);
    }
  });

  it('renders a before and after table with steps and clip', () => {
    const image = {
      route: '/items',
      state: 'item-created',
      viewport: { width: 1280, height: 800 },
      url: 'https://x/after.png',
      beforeUrl: 'https://x/before.png',
      clipUrl: 'https://x/clip.gif',
      clipFormat: 'gif' as const,
      steps,
    };
    const block = renderVisualProofBlock({ ...passResult, images: [image] });
    expect(block).toContain('| Before | After |');
    expect(block).toContain('| --- | --- |');
    expect(block).toContain(
      '| ![/items item-created before](https://x/before.png) | ![/items item-created after at abcdef012345](https://x/after.png) |',
    );
    expect(block).toContain('Steps: 1. click "#new" · 2. fill "#name" with "Demo" · 3. press Enter');
    expect(block).toContain('![clip](https://x/clip.gif)');
    const video = renderVisualProofBlock({
      ...passResult,
      images: [{ ...image, clipUrl: 'https://x/clip.webm', clipFormat: 'webm' as const }],
    });
    expect(video).toContain('[▶ clip (webm)](https://x/clip.webm)');
    expect(video).not.toContain('![clip]');
  });

  it('renders a coverage warning for uncovered UI files', () => {
    const block = renderVisualProofBlock({ ...passResult, images: [], uncovered: ['web/a.css', 'web/b.css'] });
    expect(block).toContain('- Coverage warning: UI files not covered by any visualProof route: web/a.css, web/b.css');
  });

  it('renders a visual proof unavailable line for every non-pass result', () => {
    for (const status of ['fail', 'unavailable'] as const) {
      for (const mode of ['required', 'advisory'] as const) {
        const block = renderVisualProofBlock(
          { status, headSha: HEAD, runId: 'run-9', captures: [], diagnostic: 'boom\nbad' },
          mode,
        );
        expect(block).toContain('**Visual proof unavailable: boom bad**');
        expect(block).toContain('- Diagnostic: boom bad');
      }
    }
    const noReason = renderVisualProofBlock({ status: 'fail', headSha: HEAD, runId: 'run-9', captures: [] });
    expect(noReason).toContain('**Visual proof unavailable: fail**');
    expect(renderVisualProofBlock(passResult)).not.toContain('unavailable');
  });
});
