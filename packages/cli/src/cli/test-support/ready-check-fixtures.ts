import { vi } from 'vitest';

export const body = (criteria: number, opts: { verification?: boolean } = {}) => `### Problem statement

Something is wrong.

### In scope

- Fix it.

### Out of scope

Nothing else.

### Acceptance criteria

${Array.from({ length: criteria }, (_, i) => `- [ ] criterion ${i + 1}`).join('\n')}
${opts.verification === false ? '' : '\n### Verification\n\nbash scripts/verify.sh\n'}`;

export function deps(b: string, title = 'Fix it') {
  const lines: string[] = [];
  const getIssue = vi.fn(async () => ({ title, body: b as string | null }));
  return { lines, getIssue, d: { getIssue, log: (l: string) => lines.push(l) } };
}
