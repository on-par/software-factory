# ADR-0120: Repo config writers preserve the file's format, edit YAML in place, and only `factory migrate --to-yaml` switches format

- Status: Accepted
- Date: 2026-10-01

## Context

ADR-0119 made `.factory/config.yaml` the preferred repo config and kept `config.json` readable, but left the writers emitting JSON. The safe-policy writer (ADR-0094's settings surface) rebuilt the parsed object and re-serialized it, which on a YAML file would discard every comment an operator wrote, the main reason to offer YAML at all. Writers also must not quietly move a JSON repo to YAML: a format switch changes the file that operators, CI and other tools look at, so it has to be a visible, deliberate act. Deleting the old file is irreversible, so a conversion needs a check before it removes anything.

## Decision

All repo-config writes go through core's config-file module (`packages/core/src/config/repo-config-file.ts`), beside `readRepoConfigFile`. `setRepoConfigValue` writes in the format of the file it is given. For `.yaml`/`.yml` it edits the parsed `yaml` Document (`parseDocument` + `setIn`) and writes `doc.toString()`, so comments, blank lines and key order survive. For `.json` it keeps writing two-space JSON. A new repo gets `config.yaml` (`factory init`, or the policy writer when no file exists). No writer converts an existing file to a different format. The only format switch is `factory migrate --to-yaml` (`migrateRepoConfigToYaml`). It writes `config.yaml`, reads it back, and deletes `config.json` only when the read-back deep-equals the JSON value. Otherwise it removes the new YAML, keeps the JSON and exits non-zero. Code that writes repo config must use these helpers and must not `JSON.stringify` or `yaml.stringify` a whole parsed config over an existing file.

## Consequences

Operators can comment their YAML config and then use the dashboard settings toggles without losing those comments. JSON repos behave exactly as before until someone runs `factory migrate --to-yaml`. The CLI stays free of a direct `yaml` dependency. The cost is two write paths (Document edit for YAML, object rewrite for JSON) that must be kept in step. The existing v1→v2 rewrite in `factory migrate` is still JSON-only, and moving it onto these helpers is left for later. The migration generates YAML from data, so the JSON's key order is kept but it has no comments beyond the header.

References: ADR-0119; [yaml Document API](https://eemeli.org/yaml/#documents).
