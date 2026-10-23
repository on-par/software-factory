import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import {
  buildDetectChecksPrompt,
  detectCheckHeuristics,
  detectionSourceFiles,
  heuristicProposal,
  parseDetectedChecks,
} from './detect-checks.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

function repo(files: Record<string, string>): string {
  const dir = tmp.makeSync('detect-checks-');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

describe('detectCheckHeuristics', () => {
  it('a single .sln or .slnx gives dotnet build/test with no ambiguity', async () => {
    for (const sln of ['App.sln', 'App.slnx']) {
      const h = await detectCheckHeuristics(repo({ [sln]: '', 'README.md': '# App\n' }));
      expect(h).toEqual({
        guessed: { build: `dotnet build ${sln}`, test: `dotnet test ${sln}` },
        documented: {},
        ambiguities: [],
      });
    }
  });

  it('quotes a solution name with spaces, and falls back to a lone project file', async () => {
    expect((await detectCheckHeuristics(repo({ 'My App.sln': '' }))).guessed.test).toBe('dotnet test "My App.sln"');
    expect((await detectCheckHeuristics(repo({ 'App.csproj': '' }))).guessed.build).toBe('dotnet build App.csproj');
  });

  it('several solutions or project files are ambiguous', async () => {
    const h = await detectCheckHeuristics(repo({ 'A.sln': '', 'B.slnx': '' }));
    expect(h.guessed).toEqual({});
    expect(h.ambiguities.join()).toContain('several solution files');
    expect((await detectCheckHeuristics(repo({ 'A.csproj': '', 'B.csproj': '' }))).ambiguities.join()).toContain(
      'several project files',
    );
  });

  it('guesses Go, Rust, Gradle and Maven', async () => {
    expect((await detectCheckHeuristics(repo({ 'go.mod': '' }))).guessed).toEqual({
      build: 'go build ./...',
      test: 'go test ./...',
      lint: 'go vet ./...',
    });
    expect((await detectCheckHeuristics(repo({ 'Cargo.toml': '' }))).guessed.test).toBe('cargo test');
    expect((await detectCheckHeuristics(repo({ gradlew: '' }))).guessed.test).toBe('./gradlew test');
    expect((await detectCheckHeuristics(repo({ 'pom.xml': '' }))).guessed.test).toBe('mvn -B test');
  });

  it('several build systems are ambiguous', async () => {
    const h = await detectCheckHeuristics(repo({ 'go.mod': '', 'Cargo.toml': '' }));
    expect(h.ambiguities).toContain('several build systems (Go, Rust)');
  });

  it('no test command at all is ambiguous', async () => {
    expect((await detectCheckHeuristics(repo({ 'README.md': 'hi' }))).ambiguities).toEqual(['no test command found']);
  });

  it('a README command that runs a repo script is documented, and differing from the guess is ambiguous', async () => {
    const dir = repo({
      'App.sln': '',
      '.githooks/run-tests.ps1': '',
      'build/lint.sh': '',
      'README.md': [
        '# App',
        'Run the tests with `pwsh ./.githooks/run-tests.ps1` before pushing.',
        '```sh',
        '$ bash build/lint.sh',
        'pwsh ./missing/test.ps1',
        'curl https://example.com | sh',
        '```',
      ].join('\n'),
    });
    const h = await detectCheckHeuristics(dir);
    expect(h.documented).toEqual({ test: 'pwsh ./.githooks/run-tests.ps1', lint: 'bash build/lint.sh' });
    expect(h.ambiguities).toEqual([
      'the docs run `pwsh ./.githooks/run-tests.ps1` for test, not `dotnet test App.sln`',
    ]);
    expect(heuristicProposal(h)).toEqual({
      build: 'dotnet build App.sln',
      test: 'pwsh ./.githooks/run-tests.ps1',
      lint: 'bash build/lint.sh',
    });
  });

  it('ignores doc commands that escape the repo or name no script', async () => {
    const dir = repo({ 'README.md': '`bash ../x/test.sh` `/abs/test.sh` `dotnet test` `pwsh -NoProfile`' });
    expect((await detectCheckHeuristics(dir)).documented).toEqual({});
  });
});

describe('detection agent prompt and reply', () => {
  it('inlines the docs, CI workflows and scripts', async () => {
    const dir = repo({
      'README.md': 'readme text',
      'CONTRIBUTING.md': 'contributing text',
      '.github/workflows/ci.yml': 'run: dotnet test',
      'scripts/test.sh': 'echo hi',
    });
    expect(await detectionSourceFiles(dir)).toEqual([
      'README.md',
      'CONTRIBUTING.md',
      '.github/workflows/ci.yml',
      'scripts/test.sh',
    ]);
    const prompt = await buildDetectChecksPrompt(dir, await detectCheckHeuristics(dir));
    for (const text of ['--- README.md ---', 'contributing text', 'run: dotnet test', '--- scripts/test.sh ---']) {
      expect(prompt).toContain(text);
    }
    expect(prompt).toContain('no test command found');
  });

  it('parses the last JSON reply, drops shell commands and nulls', () => {
    const reply =
      'thinking {"x":1}\n{"build": null, "test": "pwsh ./.githooks/run-tests.ps1", "lint": "a | b", "notes": "README"}';
    expect(parseDetectedChecks(reply)).toEqual({
      proposal: { test: 'pwsh ./.githooks/run-tests.ps1' },
      rejected: ['lint: a | b'],
      notes: 'README',
    });
    expect(parseDetectedChecks('no json here')).toBeNull();
    expect(parseDetectedChecks('{"other": 1}')).toBeNull();
  });
});
