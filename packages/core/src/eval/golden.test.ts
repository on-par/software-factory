import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadGoldenCases } from './golden.js';

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'factory-eval-golden-'));
  tempDirs.push(dir);
  return dir;
}

describe('loadGoldenCases', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('parses defaults and extracts title/body', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'case.md'), `# Fix the thing

The body explains the issue.
`);

    const cases = await loadGoldenCases(dir);

    expect(cases).toMatchObject([{
      id: 'case',
      title: 'Fix the thing',
      body: 'The body explains the issue.',
      expectedRoute: 'any',
      deterministicOnly: false,
      rubric: [],
      minRubricScore: 7,
    }]);
    expect(cases[0].constitution).toBeUndefined();
  });

  it('extracts and strips stub-output blocks', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'case.md'), `---
id: with-stub
expectedRoute: codex
deterministicOnly: true
rubric:
  - Names the changed file
minRubricScore: 8
---
# Add a check

Issue body.

\`\`\`stub-output
---
route: codex
---
# Spec
\`\`\`
`);

    const [golden] = await loadGoldenCases(dir);

    expect(golden.id).toBe('with-stub');
    expect(golden.expectedRoute).toBe('codex');
    expect(golden.deterministicOnly).toBe(true);
    expect(golden.rubric).toEqual(['Names the changed file']);
    expect(golden.minRubricScore).toBe(8);
    expect(golden.stubOutput).toContain('route: codex');
    expect(golden.body).toBe('Issue body.');
  });

  it('sorts cases by filename', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'b.md'), '# B\n\nbody');
    await writeFile(join(dir, 'a.md'), '# A\n\nbody');

    const cases = await loadGoldenCases(dir);

    expect(cases.map(c => c.id)).toEqual(['a', 'b']);
  });

  it('throws on bad expectedRoute and names the file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'bad.md');
    await writeFile(path, `---
expectedRoute: gpt
---
# Bad

body
`);

    await expect(loadGoldenCases(dir)).rejects.toThrow(`${path}: invalid expectedRoute 'gpt'`);
  });

  it('parses inline constitution frontmatter', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'case.md'), `---
id: with-constitution
expectedRoute: codex
constitution: |
  <constitution product="eval-demo">
  # Standards
  - S1: Label user-facing strings.
  </constitution>
---
# Add a CLI flag

Issue body.
`);

    const [golden] = await loadGoldenCases(dir);

    expect(golden.constitution).toContain('<constitution product="eval-demo">');
    expect(golden.constitution).toContain('S1: Label user-facing strings.');
  });
});
