// packages/scbench-adapter/src/catalog-preflight.ts — adapter build + problem-catalog preflight (#1140).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** One catalog-preflight input to check: the compiled adapter bin, the pinned
 *  problem-catalog checkout, and the problem ids a run selects from it. */
export interface CatalogPreflightSpec {
  /** Absolute path of the compiled adapter bin the harness invokes (dist/cli.js). */
  adapterCli: string;
  /** SCBENCH_PROBLEMS_PATH value; undefined/empty means unset. */
  catalogPath: string | undefined;
  /** Selected problem ids (baseline config smoke + suite, deduped by the caller). */
  problemIds: readonly string[];
}

export interface CatalogPreflightResult {
  subject: string;
  ok: boolean;
  detail: string;
}

export interface CatalogPreflightOutcome {
  ok: boolean;
  results: CatalogPreflightResult[];
  /** Problem ids that resolved in the catalog — [] unless the catalog root passed. */
  confirmedProblemIds: string[];
}

export interface CatalogPreflightDeps {
  exists?: (path: string) => boolean;
}

/** Checks the adapter build output, the SCBENCH_PROBLEMS_PATH catalog root,
 *  and each selected problem id against that catalog, without short-
 *  circuiting across subjects (mirroring `runPinPreflight`) — so a single run
 *  reports every failing input. Per-problem checks are skipped only when the
 *  catalog root itself fails, since a broken root would make every id
 *  spuriously "unknown". */
export function runCatalogPreflight(
  spec: CatalogPreflightSpec,
  deps: CatalogPreflightDeps = {},
): CatalogPreflightOutcome {
  const exists = deps.exists ?? existsSync;
  const results: CatalogPreflightResult[] = [];
  const confirmedProblemIds: string[] = [];

  if (exists(spec.adapterCli)) {
    results.push({ subject: 'adapter build', ok: true, detail: `build output present: ${spec.adapterCli}` });
  } else {
    results.push({
      subject: 'adapter build',
      ok: false,
      detail: `missing build output ${spec.adapterCli} — run \`npm run build\` first`,
    });
  }

  const catalogPath = spec.catalogPath;
  let catalogOk: boolean;
  if (catalogPath === undefined || catalogPath === '') {
    catalogOk = false;
    results.push({ subject: 'SCBENCH_PROBLEMS_PATH', ok: false, detail: 'is not set' });
  } else if (!exists(catalogPath)) {
    catalogOk = false;
    results.push({ subject: 'SCBENCH_PROBLEMS_PATH', ok: false, detail: `path does not exist: ${catalogPath}` });
  } else {
    catalogOk = true;
    results.push({ subject: 'SCBENCH_PROBLEMS_PATH', ok: true, detail: `catalog checkout present: ${catalogPath}` });
  }

  if (catalogOk && catalogPath !== undefined) {
    for (const id of spec.problemIds) {
      const configPath = join(catalogPath, id, 'config.yaml');
      if (exists(configPath)) {
        results.push({ subject: `problem ${id}`, ok: true, detail: `resolves in catalog (${id}/config.yaml)` });
        confirmedProblemIds.push(id);
      } else {
        results.push({
          subject: `problem ${id}`,
          ok: false,
          detail: `unknown problem id ${id} — no config.yaml at ${configPath}`,
        });
      }
    }
  }

  return { ok: results.every((r) => r.ok), results, confirmedProblemIds };
}
