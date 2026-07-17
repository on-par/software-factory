import type { ApprovalRequest } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalPrompt } from './ApprovalPrompt.js';

afterEach(cleanup);

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-1',
    issue: 296,
    branch: 'ship-it/296-thing',
    worktree: '/repo-296',
    diffStat: ' file.ts | 2 ++\n',
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ApprovalPrompt', () => {
  it('shows the issue, branch, diff stat, and the y/n hint', () => {
    const { lastFrame } = render(<ApprovalPrompt request={makeRequest()} pendingCount={1} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('APPROVAL REQUIRED');
    expect(frame).toContain('#296');
    expect(frame).toContain('ship-it/296-thing');
    expect(frame).toContain('file.ts');
    expect(frame).toContain('y approve · n deny');
  });

  it('shows the check summary line when present', () => {
    const request = makeRequest({ checkSummary: { failures: 1, passes: 4, skips: 2, total: 7, results: [] } });
    const { lastFrame } = render(<ApprovalPrompt request={request} pendingCount={1} />);
    expect(lastFrame()).toContain('checks: 4 pass, 1 fail, 2 skip');
  });

  it('omits the check summary line when absent', () => {
    const { lastFrame } = render(<ApprovalPrompt request={makeRequest()} pendingCount={1} />);
    expect(lastFrame()).not.toContain('checks:');
  });

  it('shows the reason line and typed text in deny mode', () => {
    const { lastFrame } = render(<ApprovalPrompt request={makeRequest()} pendingCount={1} denyReason="not ready" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('deny reason (Enter submit, Esc cancel): not ready');
    expect(frame).not.toContain('y approve');
  });

  it('truncates a long diff stat with a truncated tail', () => {
    const diffStat = Array.from({ length: 15 }, (_, i) => ` file${i}.ts | 1 +`).join('\n');
    const { lastFrame } = render(<ApprovalPrompt request={makeRequest({ diffStat })} pendingCount={1} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('file0.ts');
    expect(frame).not.toContain('file14.ts');
    expect(frame).toContain('… (truncated)');
  });

  it('shows "[1 of N]" when more than one approval is pending', () => {
    const { lastFrame } = render(<ApprovalPrompt request={makeRequest()} pendingCount={3} />);
    expect(lastFrame()).toContain('[1 of 3]');
  });

  it('does not show "[1 of N]" when only one approval is pending', () => {
    const { lastFrame } = render(<ApprovalPrompt request={makeRequest()} pendingCount={1} />);
    expect(lastFrame()).not.toContain('[1 of');
  });
});
