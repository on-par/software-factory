---
design:
  restatedProblem: >-
    A run reads its config only from the per-run overrides (--config /
    FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML, then FACTORY_CONFIG_OVERRIDES
    merged on top) or from the checkout's .factory/config.yaml, and reads its
    constitution only from --constitution / FACTORY_CONSTITUTION_PATH /
    FACTORY_CONSTITUTION or the checkout's .factory/constitution.md. Teams that
    keep project config in a central directory outside the checkout have to copy
    it into the repo. This change adds an external project-config directory
    source, set by the global flag --project-config <dir> or the env var
    FACTORY_PROJECT_CONFIG_DIR (the flag wins). When it is set, config.yaml and
    constitution.md are read from that directory instead of the repo's .factory/
    files, at rank 3 of the existing ladder. Ranks 1 and 2 stay above it. The
    external config is checked with the existing strict schemas, and a bad file
    fails before PLAN with an error that names the source and the file path.
    With the source unset, nothing changes.
  approach:
    chosen: >-
      Put the new rank inside the existing ladder in
      packages/core/src/config/run-config-ladder.ts. A new exported
      resolveProjectConfigDir(env) reads FACTORY_PROJECT_CONFIG_DIR plus
      FACTORY_PROJECT_CONFIG_DIR_SOURCE. It returns { dir, source } where source
      is '--project-config' or 'FACTORY_PROJECT_CONFIG_DIR', and it throws when
      the directory does not exist. pickWinner checks it after
      FACTORY_CONFIG_YAML and before the repo file. resolveConstitutionOverride
      checks it after inline FACTORY_CONSTITUTION.
      ConstitutionLoader.loadRepoConstitution skips the repo
      .factory/constitution.md when the source is set. The CLI global flag
      --project-config is resolved to an absolute directory in
      applyConfigOverrideOptions and written to FACTORY_PROJECT_CONFIG_DIR, with
      _SOURCE set to '--project-config'. That overwrites any env value, so the
      flag wins, and every subprocess (lanes, CHECK) inherits it like --config
      does today.
    rejected:
      - option: >-
          Implement it as another whole-file override by writing the dir's
          config.yaml into FACTORY_CONFIG_PATH from the CLI.
        reason: >-
          That would put the new source at rank 2, where it would clash with
          FACTORY_CONFIG_YAML and --config. It would also skip the env-only
          path, which never goes through the CLI flag code.
      - option: Report the external source with the existing 'repo' label.
        reason: >-
          describeConfigSources would then print `.factory/config.yaml`, which
          misnames where the config came from. The ladder also skips strict
          validation for 'repo', so a bad external file would not fail before
          PLAN.
      - option: >-
          Fall back to the repo .factory/ file when the external directory lacks
          config.yaml or constitution.md.
        reason: >-
          The issue says the external directory is read in place of the repo
          files. Mixing the two silently would make the source ambiguous. A
          missing file in the external directory is treated like a repo with no
          such file.
      - option: Put the tests at tests/config/*.spec.ts as the issue names them.
        reason: >-
          vitest.config.ts only collects packages/*/src/**/*.test.{ts,tsx}, so
          those files would never run, and the constitution requires colocated
          *.test.ts. The same test names are used in colocated files instead.
  interfacesTouched:
    - >-
      packages/core/src/config/run-config-ladder.ts — ConfigSourceLabel gains
      '--project-config' | 'FACTORY_PROJECT_CONFIG_DIR'; new export
      resolveProjectConfigDir; pickWinner and resolveConstitutionOverride check
      it at rank 3; invalid-source errors for the new labels include the file
      path
    - >-
      packages/core/src/constitutions/index.ts —
      ConstitutionLoader.loadRepoConstitution returns null instead of reading
      the repo instance when a project-config dir is set without constitution.md
    - >-
      packages/cli/src/cli/config-override-option.ts —
      applyConfigOverrideOptions accepts projectConfig, checks the directory and
      writes FACTORY_PROJECT_CONFIG_DIR(_SOURCE)
    - >-
      packages/cli/src/cli/program.ts — global option --project-config <dir>,
      passed to applyConfigOverrideOptions
    - 'docs/runbooks/config-overrides.md, CHANGELOG.md'
  targetTypes:
    - name: ConfigSourceLabel
      file: packages/core/src/config/run-config-ladder.ts
      kind: changed
    - name: RunConfigLadder
      file: packages/core/src/config/run-config-ladder.ts
      kind: read
    - name: ConstitutionLoader
      file: packages/core/src/constitutions/index.ts
      kind: changed
  signatures:
    - symbol: resolveProjectConfigDir
      file: packages/core/src/config/run-config-ladder.ts
      signature: >-
        export function resolveProjectConfigDir(env: NodeJS.ProcessEnv =
        process.env): { dir: string; source: ConfigSourceLabel } | undefined
    - symbol: resolveRunConfigLadder
      file: packages/core/src/config/run-config-ladder.ts
      signature: >-
        export function resolveRunConfigLadder(configPath: string, env:
        NodeJS.ProcessEnv = process.env): RunConfigLadder
    - symbol: resolveConstitutionOverride
      file: packages/core/src/config/run-config-ladder.ts
      signature: >-
        export function resolveConstitutionOverride(env: NodeJS.ProcessEnv =
        process.env): { text: string; source: ConfigSourceLabel; path?: string }
        | undefined
    - symbol: applyConfigOverrideOptions
      file: packages/cli/src/cli/config-override-option.ts
      signature: >-
        export function applyConfigOverrideOptions(flags: { config?: string;
        constitution?: string; projectConfig?: string }, cwd: string, env:
        NodeJS.ProcessEnv = process.env): void
    - symbol: ConstitutionLoader.loadRepoConstitution
      file: packages/core/src/constitutions/index.ts
      signature: >-
        loadRepoConstitution(repoDir: string, relPath: string =
        DEFAULT_REPO_CONSTITUTION_PATH): Constitution | null
  callGraph:
    - from: buildProgram preAction hook
      to: applyConfigOverrideOptions
      note: >-
        passes program.opts().projectConfig together with config and
        constitution; a thrown error becomes CliExitError exit 2
    - from: applyConfigOverrideOptions
      to: process.env
      note: >-
        writes FACTORY_PROJECT_CONFIG_DIR=<absolute dir> and
        FACTORY_PROJECT_CONFIG_DIR_SOURCE=--project-config, overwriting any env
        value
    - from: pickWinner
      to: resolveProjectConfigDir
      note: >-
        after FACTORY_CONFIG_YAML and before the repo file; when set, reads
        resolveRepoConfigPath(dir) through readRepoConfigFile
    - from: resolveConstitutionOverride
      to: resolveProjectConfigDir
      note: >-
        after inline FACTORY_CONSTITUTION; returns <dir>/constitution.md text
        with the project-config source label
    - from: ConstitutionLoader.loadRepoConstitution
      to: resolveProjectConfigDir
      note: >-
        when no override text is found but the dir is set, returns null instead
        of reading the repo .factory/constitution.md
    - from: shipIssue
      to: holdRunConfigSnapshot
      note: >-
        unchanged edge; resolveRunConfigLadder now throws for an invalid
        external config before reportConfigSource and PLAN
  behaviorContract:
    - >-
      With FACTORY_PROJECT_CONFIG_DIR or --project-config set and no rank-2
      override, resolveRunConfigLadder returns the external dir's config.yaml
      with source '--project-config' or 'FACTORY_PROJECT_CONFIG_DIR' and path
      <dir>/config.yaml, even when the repo has .factory/config.yaml.
    - >-
      With the external source set and no constitution override,
      loadRepoConstitution returns <dir>/constitution.md (repoInstance.absPath
      equals that path), even when the repo has .factory/constitution.md.
    - >-
      --config, FACTORY_CONFIG_PATH and FACTORY_CONFIG_YAML still beat the
      external config. --constitution, FACTORY_CONSTITUTION_PATH and
      FACTORY_CONSTITUTION still beat the external constitution.
      FACTORY_CONFIG_OVERRIDES still deep-merges over whichever source wins.
    - >-
      An external config that fails the strict schemas, is not a mapping, or is
      malformed YAML throws an error containing the external dir path and
      config.yaml. shipIssue rejects before planPhase runs.
    - >-
      An external dir that does not exist throws, naming the source. With the
      flag the CLI exits 2.
    - >-
      An external dir that exists but has no config.yaml resolves to packaged
      defaults, not the repo file. An external dir with no constitution.md falls
      back to repo instruction files or the bundled constitution, not the repo
      .factory/constitution.md.
    - '--project-config wins over FACTORY_PROJECT_CONFIG_DIR when both are set.'
    - >-
      With the source unset, every existing ladder and constitution test passes
      without edits.
  verificationPlan:
    - command: >-
        npx vitest run packages/core/src/config packages/core/src/constitutions
        packages/cli/src/cli/config-override-option.test.ts
        packages/cli/src/cli/ship-config-source.test.ts
      passWhen: >-
        all tests pass, including the new named tests, with existing ladder
        specs unedited
    - command: bash scripts/verify.sh --no-e2e
      passWhen: >-
        exits 0 (format, build, type-check, lint incl. no-comments and
        package-boundaries, knip, coverage ratchet)
  riskBlastRadius: >-
    Every one-shot run (ship, run-issue, run-brief, run lanes, resume --from
    check) and factory doctor resolve config through resolveRunConfigLadder. A
    bug in the new branch could pick the wrong file or throw for every run. That
    risk is limited because the branch only runs when FACTORY_PROJECT_CONFIG_DIR
    is non-blank, and existing unedited tests guard the unset path. The
    constitution change touches PLAN/CHECK standards loading, and it is also
    gated on the env var.
  openQuestions:
    - >-
      The issue names tests/config/project-config-ladder.spec.ts and
      tests/config/project-config-validation.spec.ts. Those paths are outside
      vitest's include globs and break the colocated-test standard, so the plan
      puts the same test names in colocated files. A human may want the proof
      paths in the issue updated.
    - >-
      Out of scope bars changing the factory config line, the config_source
      event and doctor output. Their format and code stay unchanged, but when
      the new source is used they show the new label (for example config
      --project-config (<dir>/config.yaml)), because they render the ladder's
      source. constitutionSourceLabel likewise shows '--project-config' /
      'FACTORY_PROJECT_CONFIG_DIR' when the external constitution.md is used.
      Showing `.factory/config.yaml` would be wrong, so this plan accepts it. A
      dedicated reporting change can follow under issue 4336.
    - >-
      Assumption — a set external dir that lacks config.yaml or constitution.md
      does not fall back to the repo .factory/ file; it behaves like a repo with
      no such file. Confirm if fallback is preferred.
    - >-
      The container `factory job` path (packages/cli/src/cli/job.ts) has its own
      source labels and mounted-dir logic. It is not changed here. The env var
      is inherited by the child run-issue, so the ladder still honours it there.
  evidencePlan:
    - kind: fail-to-pass-test
      claim: >-
        External source replaces repo files — with FACTORY_PROJECT_CONFIG_DIR
        set to a temp dir holding config.yaml and constitution.md, and the repo
        holding its own .factory/config.yaml and .factory/constitution.md,
        resolveRunConfigLadder returns the external raw config with source
        FACTORY_PROJECT_CONFIG_DIR and path <dir>/config.yaml, and
        ConstitutionLoader.loadRepoConstitution returns the external
        constitution body.
      test: >-
        packages/core/src/config/run-config-ladder-project.test.ts "external
        source replaces repo file at rank 3"
    - kind: fail-to-pass-test
      claim: >-
        Documented order for every combination — a table-driven test over
        {external dir set/unset} x {none, --config, FACTORY_CONFIG_PATH,
        FACTORY_CONFIG_YAML} x {FACTORY_CONFIG_OVERRIDES set/unset} x {repo file
        present/absent} checks the winning source label and merged values. The
        same matrix for constitutions ({external set/unset} x {none,
        --constitution, FACTORY_CONSTITUTION_PATH, FACTORY_CONSTITUTION} x {repo
        constitution present/absent}) checks which body loadRepoConstitution
        returns.
      test: >-
        packages/core/src/config/run-config-ladder-project.test.ts "ladder
        matrix"
    - kind: command
      claim: >-
        No change without an external source — the existing ladder, constitution
        and config-source specs pass with no edits.
      command: >-
        npx vitest run packages/core/src/config/run-config-ladder.test.ts
        packages/core/src/constitutions/index.test.ts
        packages/cli/src/cli/doctor-config-sources.test.ts && git diff
        --exit-code origin/main --
        packages/core/src/config/run-config-ladder.test.ts
        packages/core/src/constitutions/index.test.ts
      passWhen: >-
        vitest reports all tests passed and git diff shows no changes to the
        existing ladder/constitution specs
      expect:
        exitCode: 0
    - kind: fail-to-pass-test
      claim: >-
        Invalid external config fails before PLAN — with
        FACTORY_PROJECT_CONFIG_DIR pointing at a dir whose config.yaml has an
        unknown top-level key, shipIssue (the run-issue path) rejects with a
        message containing the dir path and config.yaml, planPhase is not
        called, and FACTORY_RUN_CONFIG_JSON stays unset.
      test: >-
        packages/cli/src/cli/ship-config-source.test.ts "invalid external
        config.yaml names source and file"
    - kind: fail-to-pass-test
      claim: >-
        Flag wins over env var — with FACTORY_PROJECT_CONFIG_DIR=dirA in env and
        applyConfigOverrideOptions given projectConfig dirB, env ends with
        FACTORY_PROJECT_CONFIG_DIR=<abs dirB> and _SOURCE --project-config, and
        resolveRunConfigLadder returns dirB's config with source
        --project-config.
      test: >-
        packages/cli/src/cli/config-override-option.test.ts "flag wins over env
        var"
  outline:
    - result: >-
        resolveRunConfigLadder and resolveConstitutionOverride honour
        FACTORY_PROJECT_CONFIG_DIR at rank 3, with strict validation and errors
        that name the path
      files:
        - packages/core/src/config/run-config-ladder.ts
        - packages/core/src/config/run-config-ladder-project.test.ts
      automatedChecks:
        - >-
          npx vitest run
          packages/core/src/config/run-config-ladder-project.test.ts
          packages/core/src/config/run-config-ladder.test.ts
      manualChecks: []
    - result: >-
        ConstitutionLoader does not read the repo .factory/constitution.md while
        an external dir is set
      files:
        - packages/core/src/constitutions/index.ts
        - packages/core/src/config/run-config-ladder-project.test.ts
      automatedChecks:
        - >-
          npx vitest run packages/core/src/constitutions
          packages/core/src/config/run-config-ladder-project.test.ts
      manualChecks: []
    - result: >-
        The --project-config global flag sets the env var (flag wins), a missing
        dir exits 2, and shipIssue fails before PLAN on an invalid external
        config
      files:
        - packages/cli/src/cli/config-override-option.ts
        - packages/cli/src/cli/config-override-option.test.ts
        - packages/cli/src/cli/program.ts
        - packages/cli/src/cli/ship-config-source.test.ts
      automatedChecks:
        - >-
          npx vitest run packages/cli/src/cli/config-override-option.test.ts
          packages/cli/src/cli/ship-config-source.test.ts
      manualChecks:
        - factory --help lists --project-config <dir>
    - result: Runbook and changelog document the new rank
      files:
        - docs/runbooks/config-overrides.md
        - CHANGELOG.md
      automatedChecks:
        - bash scripts/verify.sh --no-e2e
      manualChecks: []
  edgeInputs:
    - FACTORY_PROJECT_CONFIG_DIR unset
    - FACTORY_PROJECT_CONFIG_DIR empty or whitespace-only
    - FACTORY_PROJECT_CONFIG_DIR pointing at a non-existent path
    - 'FACTORY_PROJECT_CONFIG_DIR pointing at a file, not a directory'
    - external dir with no config.yaml/yml/json
    - external dir with more than one of config.yaml/config.yml/config.json
    - >-
      external config.yaml that is malformed YAML, a non-mapping (scalar/list),
      or has an unknown key
    - 'external dir with no constitution.md, or an empty constitution.md'
    - FACTORY_PROJECT_CONFIG_DIR_SOURCE set to an unknown value
    - >-
      external dir set together with FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML /
      --config / FACTORY_CONFIG_OVERRIDES
    - a daemon snapshot already set (FACTORY_RUN_CONFIG_JSON)
  behaviorDelta:
    - input: FACTORY_PROJECT_CONFIG_DIR unset or blank
      branch: >-
        pickWinner falls to repo file, then packaged defaults; constitution
        falls to repo instance
      before: repo file / packaged defaults; repo .factory/constitution.md
      after: unchanged
      verdict: same
    - input: 'external dir set, holds valid config.yaml, repo has .factory/config.yaml'
      branch: new rank-3 branch in pickWinner
      before: env var ignored; repo file used
      after: >-
        external config.yaml used, source FACTORY_PROJECT_CONFIG_DIR, strictly
        validated
      verdict: better
    - input: >-
        external dir set together with FACTORY_CONFIG_PATH, --config or
        FACTORY_CONFIG_YAML
      branch: rank-2 branches return first
      before: rank-2 source wins
      after: rank-2 source wins (external not read)
      verdict: same
    - input: FACTORY_CONFIG_OVERRIDES with external dir winning
      branch: overrides merge step
      before: merged over repo file
      after: >-
        merged over the external config; the fragment is still checked on its
        own first
      verdict: better
    - input: external dir does not exist or is a file
      branch: resolveProjectConfigDir throws
      before: env var ignored
      after: 'throws ''<source>: no such directory: <dir>''; flag path exits 2'
      verdict: better
    - input: external dir exists but has no config file
      branch: pickWinner returns packaged defaults
      before: repo file used
      after: packaged defaults (repo file not consulted)
      verdict: better
    - input: 'external config.yaml malformed, non-mapping, or invalid schema'
      branch: readRepoConfigFile parse error / non-mapping check / schemaIssues
      before: env var ignored
      after: throws with the dir path and file name before PLAN
      verdict: better
    - input: 'external dir without constitution.md, no constitution override'
      branch: >-
        loadRepoConstitution returns null; review/PLAN fall to instruction files
        / bundled
      before: repo .factory/constitution.md used
      after: repo .factory/constitution.md not used
      verdict: better
    - input: FACTORY_PROJECT_CONFIG_DIR_SOURCE unknown value
      branch: label defaults to FACTORY_PROJECT_CONFIG_DIR
      before: n/a
      after: same as env-only path (mirrors FACTORY_CONFIG_PATH_SOURCE handling)
      verdict: same
    - input: daemon snapshot FACTORY_RUN_CONFIG_JSON already set
      branch: holdRunConfigSnapshot returns early
      before: snapshot wins
      after: snapshot wins
      verdict: same
  externalLists:
    - name: ConfigSourceLabel
      location: packages/core/src/config/run-config-ladder.ts ConfigSourceLabel
      source: >-
        in-repo union (no upstream); consumers checked are
        describeConfigSources, holdRunConfigSnapshot, constitutionSourceLabel
        and doctor-config-sources.ts
      gaps: []
    - name: REPO_CONFIG_FILENAMES
      location: packages/core/src/config/repo-config-file.ts REPO_CONFIG_FILENAMES
      source: >-
        in-repo list (config.yaml, config.yml, config.json); reused unchanged
        through resolveRepoConfigPath
      gaps: []
---
---
route: claude
design:
  restatedProblem: >-
    A run reads its config only from the per-run overrides (--config / FACTORY_CONFIG_PATH /
    FACTORY_CONFIG_YAML, then FACTORY_CONFIG_OVERRIDES merged on top) or from the checkout's
    .factory/config.yaml, and reads its constitution only from --constitution /
    FACTORY_CONSTITUTION_PATH / FACTORY_CONSTITUTION or the checkout's .factory/constitution.md.
    Teams that keep project config in a central directory outside the checkout have to copy it into
    the repo. This change adds an external project-config directory source, set by the global flag
    --project-config <dir> or the env var FACTORY_PROJECT_CONFIG_DIR (the flag wins). When it is set,
    config.yaml and constitution.md are read from that directory instead of the repo's .factory/
    files, at rank 3 of the existing ladder. Ranks 1 and 2 stay above it. The external config is
    checked with the existing strict schemas, and a bad file fails before PLAN with an error that
    names the source and the file path. With the source unset, nothing changes.
  approach:
    chosen: >-
      Put the new rank inside the existing ladder in packages/core/src/config/run-config-ladder.ts.
      A new exported resolveProjectConfigDir(env) reads FACTORY_PROJECT_CONFIG_DIR plus
      FACTORY_PROJECT_CONFIG_DIR_SOURCE. It returns { dir, source } where source is '--project-config'
      or 'FACTORY_PROJECT_CONFIG_DIR', and it throws when the directory does not exist. pickWinner
      checks it after FACTORY_CONFIG_YAML and before the repo file. resolveConstitutionOverride checks
      it after inline FACTORY_CONSTITUTION. ConstitutionLoader.loadRepoConstitution skips the repo
      .factory/constitution.md when the source is set. The CLI global flag --project-config is
      resolved to an absolute directory in applyConfigOverrideOptions and written to
      FACTORY_PROJECT_CONFIG_DIR, with _SOURCE set to '--project-config'. That overwrites any env
      value, so the flag wins, and every subprocess (lanes, CHECK) inherits it like --config does
      today.
    rejected:
      - option: Implement it as another whole-file override by writing the dir's config.yaml into FACTORY_CONFIG_PATH from the CLI.
        reason: That would put the new source at rank 2, where it would clash with FACTORY_CONFIG_YAML and --config. It would also skip the env-only path, which never goes through the CLI flag code.
      - option: Report the external source with the existing 'repo' label.
        reason: describeConfigSources would then print `.factory/config.yaml`, which misnames where the config came from. The ladder also skips strict validation for 'repo', so a bad external file would not fail before PLAN.
      - option: Fall back to the repo .factory/ file when the external directory lacks config.yaml or constitution.md.
        reason: The issue says the external directory is read in place of the repo files. Mixing the two silently would make the source ambiguous. A missing file in the external directory is treated like a repo with no such file.
      - option: Put the tests at tests/config/*.spec.ts as the issue names them.
        reason: vitest.config.ts only collects packages/*/src/**/*.test.{ts,tsx}, so those files would never run, and the constitution requires colocated *.test.ts. The same test names are used in colocated files instead.
  interfacesTouched:
    - packages/core/src/config/run-config-ladder.ts — ConfigSourceLabel gains '--project-config' | 'FACTORY_PROJECT_CONFIG_DIR'; new export resolveProjectConfigDir; pickWinner and resolveConstitutionOverride check it at rank 3; invalid-source errors for the new labels include the file path
    - packages/core/src/constitutions/index.ts — ConstitutionLoader.loadRepoConstitution returns null instead of reading the repo instance when a project-config dir is set without constitution.md
    - packages/cli/src/cli/config-override-option.ts — applyConfigOverrideOptions accepts projectConfig, checks the directory and writes FACTORY_PROJECT_CONFIG_DIR(_SOURCE)
    - packages/cli/src/cli/program.ts — global option --project-config <dir>, passed to applyConfigOverrideOptions
    - docs/runbooks/config-overrides.md, CHANGELOG.md
  targetTypes:
    - name: ConfigSourceLabel
      file: packages/core/src/config/run-config-ladder.ts
      kind: changed
    - name: RunConfigLadder
      file: packages/core/src/config/run-config-ladder.ts
      kind: read
    - name: ConstitutionLoader
      file: packages/core/src/constitutions/index.ts
      kind: changed
  signatures:
    - symbol: resolveProjectConfigDir
      file: packages/core/src/config/run-config-ladder.ts
      signature: 'export function resolveProjectConfigDir(env: NodeJS.ProcessEnv = process.env): { dir: string; source: ConfigSourceLabel } | undefined'
    - symbol: resolveRunConfigLadder
      file: packages/core/src/config/run-config-ladder.ts
      signature: 'export function resolveRunConfigLadder(configPath: string, env: NodeJS.ProcessEnv = process.env): RunConfigLadder'
    - symbol: resolveConstitutionOverride
      file: packages/core/src/config/run-config-ladder.ts
      signature: 'export function resolveConstitutionOverride(env: NodeJS.ProcessEnv = process.env): { text: string; source: ConfigSourceLabel; path?: string } | undefined'
    - symbol: applyConfigOverrideOptions
      file: packages/cli/src/cli/config-override-option.ts
      signature: 'export function applyConfigOverrideOptions(flags: { config?: string; constitution?: string; projectConfig?: string }, cwd: string, env: NodeJS.ProcessEnv = process.env): void'
    - symbol: ConstitutionLoader.loadRepoConstitution
      file: packages/core/src/constitutions/index.ts
      signature: 'loadRepoConstitution(repoDir: string, relPath: string = DEFAULT_REPO_CONSTITUTION_PATH): Constitution | null'
  callGraph:
    - from: buildProgram preAction hook
      to: applyConfigOverrideOptions
      note: passes program.opts().projectConfig together with config and constitution; a thrown error becomes CliExitError exit 2
    - from: applyConfigOverrideOptions
      to: process.env
      note: writes FACTORY_PROJECT_CONFIG_DIR=<absolute dir> and FACTORY_PROJECT_CONFIG_DIR_SOURCE=--project-config, overwriting any env value
    - from: pickWinner
      to: resolveProjectConfigDir
      note: after FACTORY_CONFIG_YAML and before the repo file; when set, reads resolveRepoConfigPath(dir) through readRepoConfigFile
    - from: resolveConstitutionOverride
      to: resolveProjectConfigDir
      note: after inline FACTORY_CONSTITUTION; returns <dir>/constitution.md text with the project-config source label
    - from: ConstitutionLoader.loadRepoConstitution
      to: resolveProjectConfigDir
      note: when no override text is found but the dir is set, returns null instead of reading the repo .factory/constitution.md
    - from: shipIssue
      to: holdRunConfigSnapshot
      note: unchanged edge; resolveRunConfigLadder now throws for an invalid external config before reportConfigSource and PLAN
  behaviorContract:
    - With FACTORY_PROJECT_CONFIG_DIR or --project-config set and no rank-2 override, resolveRunConfigLadder returns the external dir's config.yaml with source '--project-config' or 'FACTORY_PROJECT_CONFIG_DIR' and path <dir>/config.yaml, even when the repo has .factory/config.yaml.
    - With the external source set and no constitution override, loadRepoConstitution returns <dir>/constitution.md (repoInstance.absPath equals that path), even when the repo has .factory/constitution.md.
    - --config, FACTORY_CONFIG_PATH and FACTORY_CONFIG_YAML still beat the external config. --constitution, FACTORY_CONSTITUTION_PATH and FACTORY_CONSTITUTION still beat the external constitution. FACTORY_CONFIG_OVERRIDES still deep-merges over whichever source wins.
    - An external config that fails the strict schemas, is not a mapping, or is malformed YAML throws an error containing the external dir path and config.yaml. shipIssue rejects before planPhase runs.
    - An external dir that does not exist throws, naming the source. With the flag the CLI exits 2.
    - An external dir that exists but has no config.yaml resolves to packaged defaults, not the repo file. An external dir with no constitution.md falls back to repo instruction files or the bundled constitution, not the repo .factory/constitution.md.
    - --project-config wins over FACTORY_PROJECT_CONFIG_DIR when both are set.
    - With the source unset, every existing ladder and constitution test passes without edits.
  verificationPlan:
    - command: npx vitest run packages/core/src/config packages/core/src/constitutions packages/cli/src/cli/config-override-option.test.ts packages/cli/src/cli/ship-config-source.test.ts
      passWhen: all tests pass, including the new named tests, with existing ladder specs unedited
    - command: bash scripts/verify.sh --no-e2e
      passWhen: exits 0 (format, build, type-check, lint incl. no-comments and package-boundaries, knip, coverage ratchet)
  riskBlastRadius: >-
    Every one-shot run (ship, run-issue, run-brief, run lanes, resume --from check) and factory
    doctor resolve config through resolveRunConfigLadder. A bug in the new branch could pick the wrong
    file or throw for every run. That risk is limited because the branch only runs when
    FACTORY_PROJECT_CONFIG_DIR is non-blank, and existing unedited tests guard the unset path. The
    constitution change touches PLAN/CHECK standards loading, and it is also gated on the env var.
  openQuestions:
    - The issue names tests/config/project-config-ladder.spec.ts and tests/config/project-config-validation.spec.ts. Those paths are outside vitest's include globs and break the colocated-test standard, so the plan puts the same test names in colocated files. A human may want the proof paths in the issue updated.
    - Out of scope bars changing the `factory: config:` line, the config_source event and doctor output. Their format and code stay unchanged, but when the new source is used they show the new label (for example `config: --project-config (<dir>/config.yaml)`), because they render the ladder's source. constitutionSourceLabel likewise shows '--project-config' / 'FACTORY_PROJECT_CONFIG_DIR' when the external constitution.md is used. Showing `.factory/config.yaml` would be wrong, so this plan accepts it. A dedicated reporting change can follow under #4336.
    - Assumption — a set external dir that lacks config.yaml or constitution.md does not fall back to the repo .factory/ file; it behaves like a repo with no such file. Confirm if fallback is preferred.
    - The container `factory job` path (packages/cli/src/cli/job.ts) has its own source labels and mounted-dir logic. It is not changed here. The env var is inherited by the child run-issue, so the ladder still honours it there.
  evidencePlan:
    - kind: fail-to-pass-test
      claim: External source replaces repo files — with FACTORY_PROJECT_CONFIG_DIR set to a temp dir holding config.yaml and constitution.md, and the repo holding its own .factory/config.yaml and .factory/constitution.md, resolveRunConfigLadder returns the external raw config with source FACTORY_PROJECT_CONFIG_DIR and path <dir>/config.yaml, and ConstitutionLoader.loadRepoConstitution returns the external constitution body.
      test: packages/core/src/config/run-config-ladder-project.test.ts "external source replaces repo file at rank 3"
    - kind: fail-to-pass-test
      claim: Documented order for every combination — a table-driven test over {external dir set/unset} x {none, --config, FACTORY_CONFIG_PATH, FACTORY_CONFIG_YAML} x {FACTORY_CONFIG_OVERRIDES set/unset} x {repo file present/absent} checks the winning source label and merged values. The same matrix for constitutions ({external set/unset} x {none, --constitution, FACTORY_CONSTITUTION_PATH, FACTORY_CONSTITUTION} x {repo constitution present/absent}) checks which body loadRepoConstitution returns.
      test: packages/core/src/config/run-config-ladder-project.test.ts "ladder matrix"
    - kind: command
      claim: No change without an external source — the existing ladder, constitution and config-source specs pass with no edits.
      command: npx vitest run packages/core/src/config/run-config-ladder.test.ts packages/core/src/constitutions/index.test.ts packages/cli/src/cli/doctor-config-sources.test.ts && git diff --exit-code origin/main -- packages/core/src/config/run-config-ladder.test.ts packages/core/src/constitutions/index.test.ts
      passWhen: vitest reports all tests passed and git diff shows no changes to the existing ladder/constitution specs
      expect:
        exitCode: 0
    - kind: fail-to-pass-test
      claim: Invalid external config fails before PLAN — with FACTORY_PROJECT_CONFIG_DIR pointing at a dir whose config.yaml has an unknown top-level key, shipIssue (the run-issue path) rejects with a message containing the dir path and config.yaml, planPhase is not called, and FACTORY_RUN_CONFIG_JSON stays unset.
      test: packages/cli/src/cli/ship-config-source.test.ts "invalid external config.yaml names source and file"
    - kind: fail-to-pass-test
      claim: Flag wins over env var — with FACTORY_PROJECT_CONFIG_DIR=dirA in env and applyConfigOverrideOptions given projectConfig dirB, env ends with FACTORY_PROJECT_CONFIG_DIR=<abs dirB> and _SOURCE --project-config, and resolveRunConfigLadder returns dirB's config with source --project-config.
      test: packages/cli/src/cli/config-override-option.test.ts "flag wins over env var"
  outline:
    - result: resolveRunConfigLadder and resolveConstitutionOverride honour FACTORY_PROJECT_CONFIG_DIR at rank 3, with strict validation and errors that name the path
      files:
        - packages/core/src/config/run-config-ladder.ts
        - packages/core/src/config/run-config-ladder-project.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/config/run-config-ladder-project.test.ts packages/core/src/config/run-config-ladder.test.ts
      manualChecks: []
    - result: ConstitutionLoader does not read the repo .factory/constitution.md while an external dir is set
      files:
        - packages/core/src/constitutions/index.ts
        - packages/core/src/config/run-config-ladder-project.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/constitutions packages/core/src/config/run-config-ladder-project.test.ts
      manualChecks: []
    - result: The --project-config global flag sets the env var (flag wins), a missing dir exits 2, and shipIssue fails before PLAN on an invalid external config
      files:
        - packages/cli/src/cli/config-override-option.ts
        - packages/cli/src/cli/config-override-option.test.ts
        - packages/cli/src/cli/program.ts
        - packages/cli/src/cli/ship-config-source.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli/config-override-option.test.ts packages/cli/src/cli/ship-config-source.test.ts
      manualChecks:
        - factory --help lists --project-config <dir>
    - result: Runbook and changelog document the new rank
      files:
        - docs/runbooks/config-overrides.md
        - CHANGELOG.md
      automatedChecks:
        - bash scripts/verify.sh --no-e2e
      manualChecks: []
  edgeInputs:
    - FACTORY_PROJECT_CONFIG_DIR unset
    - FACTORY_PROJECT_CONFIG_DIR empty or whitespace-only
    - FACTORY_PROJECT_CONFIG_DIR pointing at a non-existent path
    - FACTORY_PROJECT_CONFIG_DIR pointing at a file, not a directory
    - external dir with no config.yaml/yml/json
    - external dir with more than one of config.yaml/config.yml/config.json
    - external config.yaml that is malformed YAML, a non-mapping (scalar/list), or has an unknown key
    - external dir with no constitution.md, or an empty constitution.md
    - FACTORY_PROJECT_CONFIG_DIR_SOURCE set to an unknown value
    - external dir set together with FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML / --config / FACTORY_CONFIG_OVERRIDES
    - a daemon snapshot already set (FACTORY_RUN_CONFIG_JSON)
  behaviorDelta:
    - input: FACTORY_PROJECT_CONFIG_DIR unset or blank
      branch: pickWinner falls to repo file, then packaged defaults; constitution falls to repo instance
      before: repo file / packaged defaults; repo .factory/constitution.md
      after: unchanged
      verdict: same
    - input: external dir set, holds valid config.yaml, repo has .factory/config.yaml
      branch: new rank-3 branch in pickWinner
      before: env var ignored; repo file used
      after: external config.yaml used, source FACTORY_PROJECT_CONFIG_DIR, strictly validated
      verdict: better
    - input: external dir set together with FACTORY_CONFIG_PATH, --config or FACTORY_CONFIG_YAML
      branch: rank-2 branches return first
      before: rank-2 source wins
      after: rank-2 source wins (external not read)
      verdict: same
    - input: FACTORY_CONFIG_OVERRIDES with external dir winning
      branch: overrides merge step
      before: merged over repo file
      after: merged over the external config; the fragment is still checked on its own first
      verdict: better
    - input: external dir does not exist or is a file
      branch: resolveProjectConfigDir throws
      before: env var ignored
      after: throws '<source>: no such directory: <dir>'; flag path exits 2
      verdict: better
    - input: external dir exists but has no config file
      branch: pickWinner returns packaged defaults
      before: repo file used
      after: packaged defaults (repo file not consulted)
      verdict: better
    - input: external config.yaml malformed, non-mapping, or invalid schema
      branch: readRepoConfigFile parse error / non-mapping check / schemaIssues
      before: env var ignored
      after: throws with the dir path and file name before PLAN
      verdict: better
    - input: external dir without constitution.md, no constitution override
      branch: loadRepoConstitution returns null; review/PLAN fall to instruction files / bundled
      before: repo .factory/constitution.md used
      after: repo .factory/constitution.md not used
      verdict: better
    - input: FACTORY_PROJECT_CONFIG_DIR_SOURCE unknown value
      branch: label defaults to FACTORY_PROJECT_CONFIG_DIR
      before: n/a
      after: same as env-only path (mirrors FACTORY_CONFIG_PATH_SOURCE handling)
      verdict: same
    - input: daemon snapshot FACTORY_RUN_CONFIG_JSON already set
      branch: holdRunConfigSnapshot returns early
      before: snapshot wins
      after: snapshot wins
      verdict: same
  externalLists:
    - name: ConfigSourceLabel
      location: packages/core/src/config/run-config-ladder.ts ConfigSourceLabel
      source: in-repo union (no upstream); consumers checked are describeConfigSources, holdRunConfigSnapshot, constitutionSourceLabel and doctor-config-sources.ts
      gaps: []
    - name: REPO_CONFIG_FILENAMES
      location: packages/core/src/config/repo-config-file.ts REPO_CONFIG_FILENAMES
      source: in-repo list (config.yaml, config.yml, config.json); reused unchanged through resolveRepoConfigPath
      gaps: []
---
# Spec: config: resolve --project-config / FACTORY_PROJECT_CONFIG_DIR as rank 3 for config.yaml and constitution.md (#4338)

## Goal

Let an operator keep a project's `config.yaml` and `constitution.md` outside the checkout. They point a run at that directory with the global flag `--project-config <dir>` or the env var `FACTORY_PROJECT_CONFIG_DIR`, and the flag wins if both are set. That directory replaces the repo's `.factory/config.yaml` and `.factory/constitution.md` at rank 3 of the existing per-run ladder (#3906). The rank-2 whole-file overrides and the constitution overrides stay above it, and `FACTORY_CONFIG_OVERRIDES` still merges on top. External config gets the same strict schema check as the other overrides, and it fails before PLAN with an error that names the directory and the file.

## Files / approach

1. **`packages/core/src/config/run-config-ladder.ts`**
   - Extend `ConfigSourceLabel` with `'--project-config' | 'FACTORY_PROJECT_CONFIG_DIR'`.
   - Add `export function resolveProjectConfigDir(env = process.env): { dir: string; source: ConfigSourceLabel } | undefined`:
     - If `env.FACTORY_PROJECT_CONFIG_DIR` is blank (use the existing `blank`), return `undefined`.
     - `source = env.FACTORY_PROJECT_CONFIG_DIR_SOURCE === '--project-config' ? '--project-config' : 'FACTORY_PROJECT_CONFIG_DIR'`.
     - `dir = resolve(value)` (import `resolve` from `node:path`, `statSync` from `node:fs`).
     - If the path is missing or not a directory, throw `` `${source}: no such directory: ${dir}` ``.
   - In `pickWinner`, after the `FACTORY_CONFIG_YAML` branch and before the repo branch:
     - `const project = resolveProjectConfigDir(env)`.
     - If it is set, `const p = resolveRepoConfigPath(project.dir)`, imported from `./repo-config-file.js`. Then `const raw = readRepoConfigFile(p)`. Its parse errors already name the full path.
     - If `raw` is `undefined`, return the packaged-defaults winner (`{ raw: { version: 2 }, source: 'packaged defaults' }`). Do not fall through to the repo file.
     - Otherwise return `{ raw, source: project.source, path: p }`.
   - Error messages for the two new labels must include the path. Add a small helper, for example `const named = (w) => w.path !== undefined && isProjectSource(w.source) ? `${w.source} (${w.path})` : w.source`. Use it in `Invalid ${…}: expected a mapping` and in the final `Invalid ${…}: ${formatIssues(issues)}`. Keep existing messages for the other labels byte-identical so existing specs stay unedited. Validation already runs for every source other than `'repo'`, so the new source is strictly checked.
   - In `resolveConstitutionOverride`, after the inline `FACTORY_CONSTITUTION` branch:
     - `const project = resolveProjectConfigDir(env)`. If it is set and `<dir>/constitution.md` exists, read it.
     - On a read error, throw `` `${source}: cannot read ${path}: …` ``, the same as the path branch.
     - If the text is non-empty after trimming, return `{ text, source: project.source, path }`.
     - If the file is empty or missing, return `undefined`.
2. **`packages/core/src/constitutions/index.ts`**
   - In `ConstitutionLoader.loadRepoConstitution`, after the `override` branch, add: `if (resolveProjectConfigDir() !== undefined) return null;`. This stops the repo `.factory/constitution.md` from being read while an external dir is set.
   - The external constitution itself comes back through the existing override branch (with `repoInstance.absPath = <dir>/constitution.md`).
   - Import `resolveProjectConfigDir` from `../config/run-config-ladder.js`.
3. **`packages/cli/src/cli/config-override-option.ts`**
   - `applyConfigOverrideOptions(flags: { config?; constitution?; projectConfig? }, cwd, env)`. When `projectConfig` is set:
     - `abs = resolve(cwd, value)`.
     - If it is missing or not a directory (`statSync(...).isDirectory()`), throw `` `--project-config: no such directory: ${abs}` ``.
     - Set `env.FACTORY_PROJECT_CONFIG_DIR = abs` and `env.FACTORY_PROJECT_CONFIG_DIR_SOURCE = '--project-config'`. Overwriting is what makes the flag beat the env var.
   - `constitutionSourceLabel` needs no code change. It already prefers `resolveConstitutionOverride()?.source`.
4. **`packages/cli/src/cli/program.ts`**
   - Add the global option `.option('--project-config <dir>', 'Read config.yaml and constitution.md from this directory instead of the repo .factory/; ranked below --config / FACTORY_CONFIG_* and --constitution; env FACTORY_PROJECT_CONFIG_DIR')`.
   - Destructure `projectConfig` from `program.opts()` and pass it to `applyConfigOverrideOptions`.
5. **Docs**
   - `docs/runbooks/config-overrides.md`: rank 3 becomes "`--project-config <dir>`, else `FACTORY_PROJECT_CONFIG_DIR`, else `.factory/config.yaml`". State that a set dir replaces the repo file (a missing `config.yaml` there means packaged defaults). Add the constitution order: `--constitution` > `FACTORY_CONSTITUTION_PATH` > `FACTORY_CONSTITUTION` > `<dir>/constitution.md` > `.factory/constitution.md`. In Validation, note that external-file errors name the dir and file.
   - `CHANGELOG.md`: under `## Unreleased`, add `### Added` with one line ending `(#4338)`.

No comments are added (anti-slop/no-comments). No schema or config keys change. `docs/config.example.yaml` is untouched.

## Tests

- **New** `packages/core/src/config/run-config-ladder-project.test.ts`. Use temp dirs created the way `run-config-ladder.test.ts` does, and an explicit `env` object or `vi.stubEnv` for the loader.
  - `"external source replaces repo file at rank 3"`: the repo has `.factory/config.yaml` and `.factory/constitution.md`, and the external dir has different ones. Assert the ladder's `raw`, `source === 'FACTORY_PROJECT_CONFIG_DIR'` and `path === <dir>/config.yaml`. Assert `new ConstitutionLoader().loadRepoConstitution(repo)` returns the external body.
  - `"ladder matrix"`: the table-driven combinations listed in the evidencePlan, for both config and constitution.
  - Edge cases: a missing dir throws naming the source; a dir without `config.yaml` gives packaged defaults even with a repo file present; a dir without `constitution.md` makes `loadRepoConstitution` return null even with a repo instance; an external config with an unknown key, or one that is not a mapping, throws with the dir path and `config.yaml` in the message.
- **Extend** `packages/cli/src/cli/config-override-option.test.ts`:
  - `"flag wins over env var"`.
  - A missing `--project-config` dir throws and exits 2 from the program, following the existing `--config` cases.
- **Extend** `packages/cli/src/cli/ship-config-source.test.ts`:
  - `"invalid external config.yaml names source and file"`: `vi.stubEnv('FACTORY_PROJECT_CONFIG_DIR', dir)` with `bogusTopLevel: 1` in `config.yaml`. `shipIssue(5, {})` rejects with a message containing `dir` and `config.yaml`. `planPhase` is not called, and `FACTORY_RUN_CONFIG_JSON` is undefined.
- Existing `run-config-ladder.test.ts`, `constitutions/index.test.ts` and `doctor-config-sources.test.ts` are not edited.
- Focused: `npx vitest run packages/core/src/config packages/core/src/constitutions packages/cli/src/cli/config-override-option.test.ts packages/cli/src/cli/ship-config-source.test.ts`. Full gate: `bash scripts/verify.sh --no-e2e`.

## Constitution compliance

- **Verify gate:** BUILD runs the focused `npx vitest related --run {files}` per `.factory/config.yaml` and reports that the full gate is still pending. CHECK runs `bash scripts/verify.sh --no-e2e`. No coverage threshold is lowered, and if the ratchet reports a rise the threshold is raised. No test is skipped and no lint rule is disabled inline. No comments are added.
- **Tests:** every changed source file has its colocated test updated or added (`run-config-ladder-project.test.ts` sits beside `run-config-ladder.ts`; constitution behaviour is also covered there; CLI tests are extended). The new tests fail before the change because the env var is ignored and the flag is unknown. Tests run from the repo root.
- **Architecture:** the change stays within `config ← core ← cli`. The CLI only changes its own file and keeps importing core through `@on-par/factory-core/internal`, and no new core export is needed by the CLI. Imports use `.js` extensions. No model ids are touched. No ADR is planned: this extends the #3906 ladder within ADR-0169, whose snapshot still carries the resolved config, and a daemon snapshot still wins.
- **Docs and release hygiene:** a CHANGELOG `## Unreleased` / `### Added` entry ending `(#4338)`, and the runbook `docs/runbooks/config-overrides.md` is updated. No `package.json` version edits. `docs/config.example.yaml` is untouched because no keys change.
- **Safety:** no secrets are involved. Paths go only through `path.resolve` and fs reads, with no shell. Error messages carry operator-supplied paths only, the same as the existing `--config` errors. No guardrails are weakened, because the external config passes the same strict schemas, and stricter than for the repo file.
- **ADR-0160:** this adds a new opt-in source rather than tightening validation of config that passes today. With the source unset, behaviour is unchanged, so no warn stage is needed.
- **Domain terms:** run, lane, park and CHECK are used as defined in CONTEXT.md.

## Non-goals

- Reading agent-memory, product or tests from the external directory.
- Changing the format of the `factory: config:` line, the `config_source` event or `factory doctor` output (they show the new label only when the source is used; see openQuestions).
- Fetching config from a URL or remote service.
- Adding config keys or changing schemas.
- Changing the container `factory job` mounted-dir logic in `packages/cli/src/cli/job.ts`.
