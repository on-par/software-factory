// packages/scbench-adapter/src/artifacts.ts — collect + validate Factory's benchmark artifacts (#510).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BENCHMARK_MANIFEST_VERSION, type BenchmarkManifest } from '@on-par/factory-core';

import { AdapterError } from './checkpoint.js';

export interface ArtifactsFsDeps {
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
  mkdirSync: typeof mkdirSync;
  copyFileSync: typeof copyFileSync;
}

const REAL_FS: ArtifactsFsDeps = { existsSync, readFileSync, mkdirSync, copyFileSync };

export interface CollectArtifactsOptions {
  /** Directory Factory wrote manifest.json + supporting files into. */
  artifactsDir: string;
  /** Directory to copy artifacts into for SCBench's own collection. */
  dest: string;
}

export interface CollectArtifactsResult {
  manifestPath: string;
  manifest: BenchmarkManifest;
  copied: string[];
}

const FIXED_FILES = ['manifest.json', 'request.json', 'events.ndjson', 'diff.patch'];

/** Native SCBench evidence files retained verbatim in each baseline trial
 *  directory (colocated with manifest.json). Names match the pinned SCBench
 *  commit's constants: EVALUATION_FILENAME, CHECKPOINT_RESULTS_FILENAME,
 *  RUN_INFO_FILENAME. */
export const NATIVE_EVIDENCE_FILES = ['evaluation.json', 'checkpoint_results.jsonl', 'run_info.yaml'] as const;

/** Read + validate manifest.json (throws AdapterError when missing, unparsable,
 *  or version-mismatched against core's BENCHMARK_MANIFEST_VERSION), then
 *  copy the fixed artifact files plus any optional report/spec referenced by
 *  the manifest into `dest`. When artifactsDir and dest are the same
 *  directory (Factory was already pointed at SCBench's own path), copying is
 *  skipped and only validation runs. */
export function collectArtifacts(
  opts: CollectArtifactsOptions,
  deps: ArtifactsFsDeps = REAL_FS,
): CollectArtifactsResult {
  const manifestPath = join(opts.artifactsDir, 'manifest.json');
  if (!deps.existsSync(manifestPath)) {
    throw new AdapterError(`no manifest.json found at ${opts.artifactsDir} — Factory did not complete a run`);
  }

  let manifest: BenchmarkManifest;
  try {
    manifest = JSON.parse(deps.readFileSync(manifestPath, 'utf-8')) as BenchmarkManifest;
  } catch (err) {
    throw new AdapterError(`could not parse ${manifestPath}: ${(err as Error).message}`);
  }

  if (manifest.manifestVersion !== BENCHMARK_MANIFEST_VERSION) {
    throw new AdapterError(
      `manifest version mismatch at ${manifestPath}: expected ${BENCHMARK_MANIFEST_VERSION}, got ${manifest.manifestVersion}`,
    );
  }

  const copied: string[] = [];
  if (resolve(opts.artifactsDir) === resolve(opts.dest)) {
    return { manifestPath, manifest, copied };
  }

  deps.mkdirSync(opts.dest, { recursive: true });
  for (const file of FIXED_FILES) {
    const src = join(opts.artifactsDir, file);
    if (deps.existsSync(src)) {
      deps.copyFileSync(src, join(opts.dest, file));
      copied.push(file);
    }
  }
  if (manifest.artifacts.report && deps.existsSync(manifest.artifacts.report)) {
    deps.copyFileSync(manifest.artifacts.report, join(opts.dest, 'report.md'));
    copied.push('report.md');
  }
  if (manifest.artifacts.spec && deps.existsSync(manifest.artifacts.spec)) {
    deps.copyFileSync(manifest.artifacts.spec, join(opts.dest, 'spec.md'));
    copied.push('spec.md');
  }

  return { manifestPath, manifest, copied };
}
