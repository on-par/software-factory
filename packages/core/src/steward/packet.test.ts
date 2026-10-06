import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wrapUntrustedIssueBody } from '../utils/untrusted-input.js';
import { buildStewardPacket } from './packet.js';

describe('buildStewardPacket', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'steward-packet-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds the full packet skeleton', async () => {
    const spec = '---\nroute: claude\n---\n# Spec\nbody\n';
    await writeFile(join(dir, 'issue-7.md'), spec);
    const p = await buildStewardPacket(dir, { number: 7, title: 'T', body: 'B' });
    expect(p.issue.untrustedBlock).toBe(wrapUntrustedIssueBody('T\n\nB'));
    expect(p.issue.untrustedBlock.startsWith('<untrusted-issue-body>')).toBe(true);
    expect(p.issue.untrustedBlock.endsWith('</untrusted-issue-body>')).toBe(true);
    expect(p.issue.title).toEqual({ originalChars: 1, chars: 1, truncated: false });
    expect(p.issue.body).toEqual({ originalChars: 1, chars: 1, truncated: false });
    expect(p.plan).toMatchObject({ status: 'present', text: spec, truncated: false, originalChars: spec.length });
  });

  it('marks a missing plan absent without throwing', async () => {
    const p = await buildStewardPacket(dir, { number: 7, title: 'Title', body: 'Body' });
    expect(p.plan).toEqual({ status: 'absent', reason: 'missing' });
    expect(p.issue.untrustedBlock).toContain('Title');
    expect(p.issue.untrustedBlock).toContain('Body');
  });

  it('truncates over-cap fields and keeps the block closed', async () => {
    await writeFile(join(dir, 'issue-1.md'), 'p'.repeat(9000));
    const p = await buildStewardPacket(dir, { number: 1, title: 't'.repeat(300), body: 'b'.repeat(9000) });
    expect(p.issue.title).toEqual({ originalChars: 300, chars: 256, truncated: true });
    expect(p.issue.body).toEqual({ originalChars: 9000, chars: 8000, truncated: true });
    expect(p.plan).toMatchObject({ status: 'present', originalChars: 9000, chars: 8000, truncated: true });
    expect(p.issue.untrustedBlock.endsWith('</untrusted-issue-body>')).toBe(true);
  });

  it('honours custom caps', async () => {
    await writeFile(join(dir, 'issue-1.md'), 'p'.repeat(50));
    const p = await buildStewardPacket(
      dir,
      { number: 1, title: 't'.repeat(20), body: 'b'.repeat(20) },
      { maxTitleChars: 5, maxBodyChars: 6, maxPlanChars: 7 },
    );
    expect(p.issue.title.chars).toBe(5);
    expect(p.issue.body.chars).toBe(6);
    expect(p.plan).toMatchObject({ chars: 7, truncated: true });
  });

  it('strips hidden content before measuring', async () => {
    const p = await buildStewardPacket(dir, { number: 1, title: 'T', body: 'a​b<!-- x -->c' });
    expect(p.issue.untrustedBlock).not.toContain('​');
    expect(p.issue.untrustedBlock).not.toContain('<!--');
    expect(p.issue.body.originalChars).toBe(3);
  });

  it('reads the plan from opts.planPath', async () => {
    const other = join(dir, 'elsewhere.md');
    await writeFile(other, 'frozen');
    const p = await buildStewardPacket(join(dir, 'nope'), { number: 1, title: 'T', body: 'B' }, { planPath: other });
    expect(p.plan).toMatchObject({ status: 'present', path: other, text: 'frozen' });
  });

  it('marks an unreadable plan absent', async () => {
    const asDir = join(dir, 'plan-dir');
    await mkdir(asDir);
    const p = await buildStewardPacket(dir, { number: 1, title: 'T', body: 'B' }, { planPath: asDir });
    expect(p.plan).toEqual({ status: 'absent', reason: 'unreadable' });
  });

  it('marks a whitespace-only plan absent', async () => {
    await writeFile(join(dir, 'issue-1.md'), '  \n\t\n');
    const p = await buildStewardPacket(dir, { number: 1, title: 'T', body: 'B' });
    expect(p.plan).toEqual({ status: 'absent', reason: 'empty' });
  });
});
