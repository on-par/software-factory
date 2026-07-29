import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BenchmarkManifest } from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectArtifacts } from './artifacts.js';
import { AdapterError } from './checkpoint.js';
import { minimalManifest } from './manifest-fixture.js';

function writeFixedArtifacts(dir: string, manifest: BenchmarkManifest) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'request.json'), '{}');
  writeFileSync(join(dir, 'events.ndjson'), '');
  writeFileSync(join(dir, 'diff.patch'), '');
}

describe('collectArtifacts', () => {
  let artifactsDir: string;
  let dest: string;

  beforeEach(() => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'scbench-artifacts-src-'));
    dest = mkdtempSync(join(tmpdir(), 'scbench-artifacts-dest-'));
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it('copies the four fixed artifact files and returns the parsed manifest', () => {
    const manifest = minimalManifest();
    writeFixedArtifacts(artifactsDir, manifest);

    const result = collectArtifacts({ artifactsDir, dest });

    expect(result.manifest.run.outcome).toBe('ready');
    expect(result.copied.sort()).toEqual(['diff.patch', 'events.ndjson', 'manifest.json', 'request.json']);
    expect(readFileSync(join(dest, 'manifest.json'), 'utf-8')).toContain('"outcome":"ready"');
  });

  it('copies optional report and spec when the manifest references them', () => {
    const reportPath = join(artifactsDir, 'source-report.md');
    const specPath = join(artifactsDir, 'source-spec.md');
    writeFileSync(reportPath, '# report');
    writeFileSync(specPath, '# spec');
    const manifest = minimalManifest({
      artifacts: {
        manifest: 'manifest.json',
        request: 'request.json',
        events: 'events.ndjson',
        diff: 'diff.patch',
        report: reportPath,
        spec: specPath,
      },
    });
    writeFixedArtifacts(artifactsDir, manifest);

    const result = collectArtifacts({ artifactsDir, dest });

    expect(result.copied).toContain('report.md');
    expect(result.copied).toContain('spec.md');
    expect(readFileSync(join(dest, 'report.md'), 'utf-8')).toBe('# report');
  });

  it('skips absent optional report/spec without failing', () => {
    const manifest = minimalManifest({
      artifacts: {
        manifest: 'manifest.json',
        request: 'request.json',
        events: 'events.ndjson',
        diff: 'diff.patch',
        report: join(artifactsDir, 'missing-report.md'),
      },
    });
    writeFixedArtifacts(artifactsDir, manifest);

    const result = collectArtifacts({ artifactsDir, dest });

    expect(result.copied).not.toContain('report.md');
  });

  it('throws AdapterError when manifest.json is missing', () => {
    expect(() => collectArtifacts({ artifactsDir, dest })).toThrow(AdapterError);
  });

  it('throws AdapterError when manifest.json is unparsable', () => {
    writeFileSync(join(artifactsDir, 'manifest.json'), '{not json');

    expect(() => collectArtifacts({ artifactsDir, dest })).toThrow(AdapterError);
  });

  it('throws AdapterError on a manifestVersion mismatch', () => {
    const manifest = minimalManifest({ manifestVersion: 999 });
    writeFixedArtifacts(artifactsDir, manifest);

    expect(() => collectArtifacts({ artifactsDir, dest })).toThrow(/manifest version mismatch/);
  });

  it('skips copying (validate-only) when artifactsDir and dest are the same directory', () => {
    const manifest = minimalManifest();
    writeFixedArtifacts(artifactsDir, manifest);

    const result = collectArtifacts({ artifactsDir, dest: artifactsDir });

    expect(result.copied).toEqual([]);
    expect(result.manifest.run.outcome).toBe('ready');
  });
});
