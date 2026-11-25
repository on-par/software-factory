---
design:
  restatedProblem: >-
    The per-run config ladder (#3906) in
    packages/core/src/config/run-config-ladder.ts reads config from --config /
    FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML, then the repo's
    .factory/config.yaml, then packaged defaults, with FACTORY_CONFIG_OVERRIDES
    deep-merged on top. The constitution reads --constitution /
    FACTORY_CONSTITUTION_PATH / FACTORY_CONSTITUTION, then the repo's
    .factory/constitution.md, then the instruction files or the bundled
    constitution. There is no way to point a run at a project config directory
    outside the checkout. This change adds a `--project-config <dir>` global
    flag and a FACTORY_PROJECT_CONFIG_DIR env var (the flag wins). When either
    is set, config.yaml and constitution.md are read from that directory instead
    of the repo's .factory/ files (rank 3). The explicit overrides still rank
    above it, and FACTORY_CONFIG_OVERRIDES still merges on top. The external
    config.yaml is always validated with the existing strict schemas. An invalid
    file fails shipIssue (run-issue, ship, ...) before PLAN, with an error that
    names the source and the file path.
  approach:
    chosen: >-
      Add one core resolver, `resolveProjectConfigDir(env)`, in
      run-config-ladder.ts. It reads FACTORY_PROJECT_CONFIG_DIR plus
      FACTORY_PROJECT_CONFIG_DIR_SOURCE (the label) and returns { dir, source }
      or undefined. `pickWinner` uses it between FACTORY_CONFIG_YAML and the
      repo file. A new `resolveProjectConstitution(env)` uses it too, and
      `ConstitutionLoader.loadRepoConstitution` calls that between the explicit
      constitution override and the repo instance. The CLI flag follows the
      existing --config pattern: applyConfigOverrideOptions resolves the flag to
      an absolute directory, checks that it exists, and writes
      FACTORY_PROJECT_CONFIG_DIR and
      FACTORY_PROJECT_CONFIG_DIR_SOURCE='--project-config' into env. Overwriting
      the env var is what makes the flag win, and it reaches every lane and
      CHECK subprocess. A project source is never 'repo', so
      resolveRunConfigLadder's existing "validate unless source is repo" branch
      always runs the strict schemas on it. The error names the source and the
      file path.
    rejected:
      - option: Fold the project constitution into resolveConstitutionOverride
        reason: >-
          constitutionSourceLabel and the config_source event read
          resolveConstitutionOverride, so folding it in would change the
          `factory: config:` line and the doctor output, which are out of scope.
          It would also put the project source above FACTORY_CONSTITUTION, which
          is the wrong rank.
      - option: Report the project source as source 'repo' with an external path
        reason: >-
          This would skip the strict validation (repo files are only validated
          when overrides are set), and describeConfigSources would mislabel the
          file as .factory/config.yaml.
      - option: >-
          Fall back to the repo .factory files when the external directory lacks
          a file
        reason: >-
          The issue says the external files replace the repo files ("in place
          of"). A silent fallback would hide a misconfigured directory. A
          missing file fails loud, naming the source, the directory and the
          file, the same way a missing --config file does.
      - option: Put the specs under tests/config/*.spec.ts as the issue literally says
        reason: >-
          vitest.config.ts only includes packages/*/src/**/*.test.{ts,tsx}, so
          specs there would never run, and the constitution requires colocated
          *.test.ts. The same test names go into colocated files instead.
  interfacesTouched:
    - >-
      packages/core/src/config/run-config-ladder.ts — ConfigSourceLabel gains
      '--project-config' and 'FACTORY_PROJECT_CONFIG_DIR'; new exports
      resolveProjectConfigDir and resolveProjectConstitution; pickWinner gains
      rank 3; validation error includes the file path for project sources
    - >-
      packages/core/src/constitutions/index.ts —
      ConstitutionLoader.loadRepoConstitution consults
      resolveProjectConstitution after resolveConstitutionOverride
    - >-
      packages/cli/src/cli/config-override-option.ts —
      applyConfigOverrideOptions accepts projectConfig (a directory)
    - >-
      packages/cli/src/cli/program.ts — global --project-config <dir> option
      passed to applyConfigOverrideOptions
    - >-
      packages/core/src/config/project-config-ladder.test.ts (new) — ladder
      tests
    - packages/cli/src/cli/config-override-option.test.ts — flag tests
    - packages/cli/src/cli/ship-config-source.test.ts — validation before PLAN
    - 'CHANGELOG.md, docs/runbooks/config-overrides.md'
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
    - symbol: resolveProjectConstitution
      file: packages/core/src/config/run-config-ladder.ts
      signature: >-
        export function resolveProjectConstitution(env: NodeJS.ProcessEnv =
        process.env): { text: string; source: ConfigSourceLabel; path: string }
        | undefined
    - symbol: resolveRunConfigLadder
      file: packages/core/src/config/run-config-ladder.ts
      signature: >-
        export function resolveRunConfigLadder(configPath: string, env:
        NodeJS.ProcessEnv = process.env): RunConfigLadder
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
    - from: program preAction hook
      to: applyConfigOverrideOptions
      note: 'passes { config, constitution, projectConfig } from program.opts()'
    - from: applyConfigOverrideOptions
      to: process.env
      note: >-
        writes the absolute FACTORY_PROJECT_CONFIG_DIR and
        FACTORY_PROJECT_CONFIG_DIR_SOURCE='--project-config', replacing any env
        value
    - from: resolveRunConfigLadder
      to: resolveProjectConfigDir
      note: >-
        called through pickWinner after FACTORY_CONFIG_YAML; on a hit, reads
        resolveRepoConfigPath(dir) with readRepoConfigFile
    - from: holdRunConfigSnapshot
      to: resolveRunConfigLadder
      note: >-
        unchanged edge; shipIssue calls it before PLAN, so an error thrown here
        stops the run before PLAN
    - from: ConstitutionLoader.loadRepoConstitution
      to: resolveProjectConstitution
      note: >-
        consulted only when resolveConstitutionOverride() returns undefined, and
        before the repo .factory/constitution.md
    - from: resolveProjectConstitution
      to: resolveProjectConfigDir
      note: gives the directory and label used to read <dir>/constitution.md
  behaviorContract:
    - >-
      With FACTORY_PROJECT_CONFIG_DIR or --project-config set and no --config /
      FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML, resolveRunConfigLadder returns
      the external config.yaml with source '--project-config' or
      'FACTORY_PROJECT_CONFIG_DIR' and path <dir>/config.yaml, even when the
      repo has .factory/config.yaml.
    - >-
      With the project source set and no --constitution /
      FACTORY_CONSTITUTION_PATH / FACTORY_CONSTITUTION, loadRepoConstitution
      returns the parsed <dir>/constitution.md with repoInstance.absPath equal
      to that file, even when the repo has .factory/constitution.md.
    - >-
      --config, FACTORY_CONFIG_PATH and FACTORY_CONFIG_YAML still beat the
      project source for config. --constitution, FACTORY_CONSTITUTION_PATH and
      FACTORY_CONSTITUTION still beat it for the constitution.
      FACTORY_CONFIG_OVERRIDES still deep-merges over whichever config wins.
    - >-
      The external config.yaml is always validated with
      factoryRuntimeConfigIssues and repoRoutingConfigIssues. Any issue throws
      `Invalid <source> (<dir>/config.yaml): <issues>`. A parse error throws
      through readRepoConfigFile, whose message already names the file.
    - >-
      A project directory that does not exist, a missing config file in it, or a
      missing or empty constitution.md throws an error naming the source label,
      the directory and the file name.
    - >-
      --project-config wins over FACTORY_PROJECT_CONFIG_DIR because
      applyConfigOverrideOptions overwrites the env var with the flag's absolute
      path. A missing flag directory makes the program exit 2, like --config.
    - >-
      With FACTORY_PROJECT_CONFIG_DIR unset or blank, every existing ladder and
      constitution result is the same as before.
  verificationPlan:
    - command: >-
        npx vitest run packages/core/src/config/project-config-ladder.test.ts
        packages/core/src/config/run-config-ladder.test.ts
        packages/core/src/constitutions/index.test.ts
        packages/cli/src/cli/config-override-option.test.ts
        packages/cli/src/cli/ship-config-source.test.ts
      passWhen: 'all tests pass, including the new ones'
    - command: >-
        npx vitest related --run packages/core/src/config/run-config-ladder.ts
        packages/core/src/constitutions/index.ts
        packages/cli/src/cli/config-override-option.ts
        packages/cli/src/cli/program.ts
      passWhen: the focused BUILD handoff command exits 0
    - command: bash scripts/verify.sh --no-e2e
      passWhen: the full gate is green (CHECK runs it before SHIP)
  riskBlastRadius: >-
    Every one-shot run goes through resolveRunConfigLadder and every
    constitution read goes through loadRepoConstitution. A mistake in the blank
    check or the rank order could change which config or constitution every run
    uses, including the factory's own self-build. The risk is limited because
    every new branch is gated on a non-blank FACTORY_PROJECT_CONFIG_DIR, and the
    existing run-config-ladder tests stay unedited as a regression guard. The
    container job path (job.ts) does not mount the external directory. That is
    out of scope, and a host path given to a container job would fail loud as a
    missing directory, never silently.
  openQuestions:
    - >-
      The issue names tests/config/project-config-ladder.spec.ts and
      tests/config/project-config-validation.spec.ts, but vitest only collects
      packages/*/src/**/*.test.ts, and the constitution requires colocated
      tests. The same test names go into
      packages/core/src/config/project-config-ladder.test.ts,
      packages/cli/src/cli/config-override-option.test.ts and
      packages/cli/src/cli/ship-config-source.test.ts.
    - >-
      Assumed: a project directory missing config.yaml (or constitution.md) is
      an error naming the source and the file. It does not fall back to the repo
      file or to defaults. A human may prefer a lenient fallback.
    - >-
      The `factory: config:` line and the doctor config-sources row are out of
      scope. describeConfigSources already renders any non-repo source
      generically, so the config half will read `--project-config
      (<dir>/config.yaml)` with no format change. constitutionSourceLabel is
      left unchanged, so the constitution half still reads
      .factory/constitution.md or the fallback label even when the external
      constitution.md is used. A follow-up should correct that label.
  evidencePlan:
    - kind: fail-to-pass-test
      claim: >-
        The external directory replaces the repo files at rank 3. With
        FACTORY_PROJECT_CONFIG_DIR set and both repo .factory files present,
        resolveRunConfigLadder returns the external config (its own
        disk.minFreeGb value, source FACTORY_PROJECT_CONFIG_DIR, path
        <dir>/config.yaml) and ConstitutionLoader.loadRepoConstitution returns
        the external constitution body.
      test: >-
        packages/core/src/config/project-config-ladder.test.ts "external source
        replaces repo file at rank 3"
    - kind: fail-to-pass-test
      claim: >-
        Every combination resolves in the documented order. A table over
        {project dir set/unset} x {--config, FACTORY_CONFIG_PATH,
        FACTORY_CONFIG_YAML, none} x {FACTORY_CONFIG_OVERRIDES set/unset} x
        {repo file present/absent} asserts the expected source label and merged
        value. A second table over {project dir} x {--constitution,
        FACTORY_CONSTITUTION_PATH, FACTORY_CONSTITUTION, none} x {repo
        constitution present/absent} asserts which body loadRepoConstitution
        returns.
      test: packages/core/src/config/project-config-ladder.test.ts "ladder matrix"
    - kind: command
      claim: >-
        No external source means no behavior change. The existing ladder and
        constitution specs pass unedited.
      command: >-
        npx vitest run packages/core/src/config/run-config-ladder.test.ts
        packages/core/src/constitutions/index.test.ts
        packages/cli/src/cli/config-override-option.test.ts
        packages/cli/src/cli/ship-config-source.test.ts
      passWhen: >-
        exit 0, and `git diff main --
        packages/core/src/config/run-config-ladder.test.ts
        packages/core/src/constitutions/index.test.ts` is empty
      expect:
        exitCode: 0
    - kind: fail-to-pass-test
      claim: >-
        An invalid external config.yaml fails before PLAN. With
        FACTORY_PROJECT_CONFIG_DIR pointing at a directory whose config.yaml has
        an unknown top-level key, shipIssue rejects with a message containing
        the directory path and 'config.yaml'. planPhase is not called and
        FACTORY_RUN_CONFIG_JSON stays unset.
      test: >-
        packages/cli/src/cli/ship-config-source.test.ts "invalid external
        config.yaml names source and file"
    - kind: fail-to-pass-test
      claim: >-
        The flag wins over the env var. With env
        FACTORY_PROJECT_CONFIG_DIR=dirA, applyConfigOverrideOptions({
        projectConfig: dirB }) sets the env to the absolute dirB with source
        '--project-config', and resolveRunConfigLadder then returns dirB's
        config with source '--project-config'.
      test: >-
        packages/cli/src/cli/config-override-option.test.ts "flag wins over env
        var"
  outline:
    - result: >-
        The core ladder resolves the project directory at rank 3 for config and
        constitution, validates the external config strictly, and names the
        source and file on errors.
      files:
        - packages/core/src/config/run-config-ladder.ts
        - packages/core/src/constitutions/index.ts
        - packages/core/src/config/project-config-ladder.test.ts
      automatedChecks:
        - >-
          npx vitest run packages/core/src/config/project-config-ladder.test.ts
          packages/core/src/config/run-config-ladder.test.ts
          packages/core/src/constitutions/index.test.ts
      manualChecks: []
    - result: >-
        `factory --project-config <dir>` sets the env for the whole run, beats
        the env var, exits 2 on a missing directory, and an invalid external
        config stops shipIssue before PLAN.
      files:
        - packages/cli/src/cli/config-override-option.ts
        - packages/cli/src/cli/program.ts
        - packages/cli/src/cli/config-override-option.test.ts
        - packages/cli/src/cli/ship-config-source.test.ts
      automatedChecks:
        - >-
          npx vitest run packages/cli/src/cli/config-override-option.test.ts
          packages/cli/src/cli/ship-config-source.test.ts
      manualChecks:
        - factory --help lists --project-config <dir>
    - result: >-
        The changelog and the config-overrides runbook document the new source
        and the full ladder order.
      files:
        - CHANGELOG.md
        - docs/runbooks/config-overrides.md
      automatedChecks:
        - npx prettier --check CHANGELOG.md docs/runbooks/config-overrides.md
      manualChecks: []
  edgeInputs:
    - FACTORY_PROJECT_CONFIG_DIR unset
    - FACTORY_PROJECT_CONFIG_DIR empty string or whitespace only
    - FACTORY_PROJECT_CONFIG_DIR relative path (resolved against process.cwd())
    - >-
      FACTORY_PROJECT_CONFIG_DIR pointing at a non-existent path or a regular
      file
    - project directory without a config.yaml / config.yml / config.json
    - project directory with both config.yaml and config.json (ambiguity)
    - >-
      project config.yaml with malformed YAML, a non-mapping document, or an
      unknown key
    - 'project directory without constitution.md, or with an empty one'
    - >-
      FACTORY_PROJECT_CONFIG_DIR_SOURCE set to anything other than
      '--project-config'
    - '--project-config given with a missing directory'
  behaviorDelta:
    - input: FACTORY_PROJECT_CONFIG_DIR unset or blank
      branch: >-
        pickWinner falls through to the repo file, then packaged defaults;
        loadRepoConstitution reads the repo instance
      before: 'repo file, then packaged defaults; repo constitution, then fallback'
      after: identical
      verdict: same
    - input: 'project directory set, no explicit config override'
      branch: new rank-3 branch in pickWinner
      before: env var ignored; the repo .factory/config.yaml was used
      after: >-
        <dir>/config.yaml is used and always strictly validated, with source
        FACTORY_PROJECT_CONFIG_DIR or --project-config
      verdict: better
    - input: >-
        project directory set together with --config / FACTORY_CONFIG_PATH /
        FACTORY_CONFIG_YAML
      branch: the earlier branches in pickWinner win
      before: explicit override used
      after: explicit override used; the project directory is not read for config
      verdict: same
    - input: project directory set together with FACTORY_CONFIG_OVERRIDES
      branch: overrides deep-merge over the rank-3 winner
      before: overrides merged over the repo file
      after: overrides merged over the external config
      verdict: better
    - input: 'project directory set, no constitution override'
      branch: new resolveProjectConstitution branch in loadRepoConstitution
      before: repo .factory/constitution.md or null
      after: '<dir>/constitution.md, with repoInstance pointing at it'
      verdict: better
    - input: >-
        project directory set together with --constitution /
        FACTORY_CONSTITUTION_PATH / FACTORY_CONSTITUTION
      branch: the resolveConstitutionOverride branch returns first
      before: override used
      after: override used
      verdict: same
    - input: 'project path missing or not a directory, or a file missing from it'
      branch: >-
        throws in resolveProjectConfigDir / pickWinner /
        resolveProjectConstitution
      before: n/a (env var ignored)
      after: >-
        throws `<source>: ...` naming the directory and the file; shipIssue
        rejects before PLAN; the CLI flag exits 2
      verdict: better
    - input: >-
        FACTORY_PROJECT_CONFIG_DIR_SOURCE has any value other than
        '--project-config'
      branch: label defaults to FACTORY_PROJECT_CONFIG_DIR
      before: n/a
      after: >-
        label FACTORY_PROJECT_CONFIG_DIR (mirrors FACTORY_CONFIG_PATH_SOURCE
        handling)
      verdict: same
  externalLists:
    - name: ConfigSourceLabel
      location: packages/core/src/config/run-config-ladder.ts ConfigSourceLabel
      source: >-
        internal union, checked against job.ts and doctor-config-sources.ts
        usages in this checkout
      gaps: []
    - name: REPO_CONFIG_FILENAMES
      location: packages/core/src/config/repo-config-file.ts REPO_CONFIG_FILENAMES
      source: >-
        in-repo constant (config.yaml, config.yml, config.json); reused
        unchanged through resolveRepoConfigPath
      gaps: []
---
---
route: claude
design:
  restatedProblem: >-
    The per-run config ladder (#3906) in packages/core/src/config/run-config-ladder.ts reads config from
    --config / FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML, then the repo's .factory/config.yaml, then packaged
    defaults, with FACTORY_CONFIG_OVERRIDES deep-merged on top. The constitution reads --constitution /
    FACTORY_CONSTITUTION_PATH / FACTORY_CONSTITUTION, then the repo's .factory/constitution.md, then the
    instruction files or the bundled constitution. There is no way to point a run at a project config directory
    outside the checkout. This change adds a `--project-config <dir>` global flag and a FACTORY_PROJECT_CONFIG_DIR
    env var (the flag wins). When either is set, config.yaml and constitution.md are read from that directory
    instead of the repo's .factory/ files (rank 3). The explicit overrides still rank above it, and
    FACTORY_CONFIG_OVERRIDES still merges on top. The external config.yaml is always validated with the existing
    strict schemas. An invalid file fails shipIssue (run-issue, ship, ...) before PLAN, with an error that names
    the source and the file path.
  approach:
    chosen: >-
      Add one core resolver, `resolveProjectConfigDir(env)`, in run-config-ladder.ts. It reads
      FACTORY_PROJECT_CONFIG_DIR plus FACTORY_PROJECT_CONFIG_DIR_SOURCE (the label) and returns
      { dir, source } or undefined. `pickWinner` uses it between FACTORY_CONFIG_YAML and the repo file. A new
      `resolveProjectConstitution(env)` uses it too, and `ConstitutionLoader.loadRepoConstitution` calls that
      between the explicit constitution override and the repo instance. The CLI flag follows the existing
      --config pattern: applyConfigOverrideOptions resolves the flag to an absolute directory, checks that it
      exists, and writes FACTORY_PROJECT_CONFIG_DIR and FACTORY_PROJECT_CONFIG_DIR_SOURCE='--project-config' into
      env. Overwriting the env var is what makes the flag win, and it reaches every lane and CHECK subprocess.
      A project source is never 'repo', so resolveRunConfigLadder's existing "validate unless source is repo"
      branch always runs the strict schemas on it. The error names the source and the file path.
    rejected:
      - option: Fold the project constitution into resolveConstitutionOverride
        reason: >-
          constitutionSourceLabel and the config_source event read resolveConstitutionOverride, so folding it in
          would change the `factory: config:` line and the doctor output, which are out of scope. It would also
          put the project source above FACTORY_CONSTITUTION, which is the wrong rank.
      - option: Report the project source as source 'repo' with an external path
        reason: >-
          This would skip the strict validation (repo files are only validated when overrides are set), and
          describeConfigSources would mislabel the file as .factory/config.yaml.
      - option: Fall back to the repo .factory files when the external directory lacks a file
        reason: >-
          The issue says the external files replace the repo files ("in place of"). A silent fallback would hide a
          misconfigured directory. A missing file fails loud, naming the source, the directory and the file,
          the same way a missing --config file does.
      - option: Put the specs under tests/config/*.spec.ts as the issue literally says
        reason: >-
          vitest.config.ts only includes packages/*/src/**/*.test.{ts,tsx}, so specs there would never run, and
          the constitution requires colocated *.test.ts. The same test names go into colocated files instead.
  interfacesTouched:
    - packages/core/src/config/run-config-ladder.ts — ConfigSourceLabel gains '--project-config' and 'FACTORY_PROJECT_CONFIG_DIR'; new exports resolveProjectConfigDir and resolveProjectConstitution; pickWinner gains rank 3; validation error includes the file path for project sources
    - packages/core/src/constitutions/index.ts — ConstitutionLoader.loadRepoConstitution consults resolveProjectConstitution after resolveConstitutionOverride
    - packages/cli/src/cli/config-override-option.ts — applyConfigOverrideOptions accepts projectConfig (a directory)
    - packages/cli/src/cli/program.ts — global --project-config <dir> option passed to applyConfigOverrideOptions
    - packages/core/src/config/project-config-ladder.test.ts (new) — ladder tests
    - packages/cli/src/cli/config-override-option.test.ts — flag tests
    - packages/cli/src/cli/ship-config-source.test.ts — validation before PLAN
    - CHANGELOG.md, docs/runbooks/config-overrides.md
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
    - symbol: resolveProjectConstitution
      file: packages/core/src/config/run-config-ladder.ts
      signature: 'export function resolveProjectConstitution(env: NodeJS.ProcessEnv = process.env): { text: string; source: ConfigSourceLabel; path: string } | undefined'
    - symbol: resolveRunConfigLadder
      file: packages/core/src/config/run-config-ladder.ts
      signature: 'export function resolveRunConfigLadder(configPath: string, env: NodeJS.ProcessEnv = process.env): RunConfigLadder'
    - symbol: applyConfigOverrideOptions
      file: packages/cli/src/cli/config-override-option.ts
      signature: 'export function applyConfigOverrideOptions(flags: { config?: string; constitution?: string; projectConfig?: string }, cwd: string, env: NodeJS.ProcessEnv = process.env): void'
    - symbol: ConstitutionLoader.loadRepoConstitution
      file: packages/core/src/constitutions/index.ts
      signature: 'loadRepoConstitution(repoDir: string, relPath: string = DEFAULT_REPO_CONSTITUTION_PATH): Constitution | null'
  callGraph:
    - from: program preAction hook
      to: applyConfigOverrideOptions
      note: passes { config, constitution, projectConfig } from program.opts()
    - from: applyConfigOverrideOptions
      to: process.env
      note: writes the absolute FACTORY_PROJECT_CONFIG_DIR and FACTORY_PROJECT_CONFIG_DIR_SOURCE='--project-config', replacing any env value
    - from: resolveRunConfigLadder
      to: resolveProjectConfigDir
      note: called through pickWinner after FACTORY_CONFIG_YAML; on a hit, reads resolveRepoConfigPath(dir) with readRepoConfigFile
    - from: holdRunConfigSnapshot
      to: resolveRunConfigLadder
      note: unchanged edge; shipIssue calls it before PLAN, so an error thrown here stops the run before PLAN
    - from: ConstitutionLoader.loadRepoConstitution
      to: resolveProjectConstitution
      note: consulted only when resolveConstitutionOverride() returns undefined, and before the repo .factory/constitution.md
    - from: resolveProjectConstitution
      to: resolveProjectConfigDir
      note: gives the directory and label used to read <dir>/constitution.md
  behaviorContract:
    - With FACTORY_PROJECT_CONFIG_DIR or --project-config set and no --config / FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML, resolveRunConfigLadder returns the external config.yaml with source '--project-config' or 'FACTORY_PROJECT_CONFIG_DIR' and path <dir>/config.yaml, even when the repo has .factory/config.yaml.
    - With the project source set and no --constitution / FACTORY_CONSTITUTION_PATH / FACTORY_CONSTITUTION, loadRepoConstitution returns the parsed <dir>/constitution.md with repoInstance.absPath equal to that file, even when the repo has .factory/constitution.md.
    - --config, FACTORY_CONFIG_PATH and FACTORY_CONFIG_YAML still beat the project source for config. --constitution, FACTORY_CONSTITUTION_PATH and FACTORY_CONSTITUTION still beat it for the constitution. FACTORY_CONFIG_OVERRIDES still deep-merges over whichever config wins.
    - The external config.yaml is always validated with factoryRuntimeConfigIssues and repoRoutingConfigIssues. Any issue throws `Invalid <source> (<dir>/config.yaml): <issues>`. A parse error throws through readRepoConfigFile, whose message already names the file.
    - A project directory that does not exist, a missing config file in it, or a missing or empty constitution.md throws an error naming the source label, the directory and the file name.
    - --project-config wins over FACTORY_PROJECT_CONFIG_DIR because applyConfigOverrideOptions overwrites the env var with the flag's absolute path. A missing flag directory makes the program exit 2, like --config.
    - With FACTORY_PROJECT_CONFIG_DIR unset or blank, every existing ladder and constitution result is the same as before.
  verificationPlan:
    - command: npx vitest run packages/core/src/config/project-config-ladder.test.ts packages/core/src/config/run-config-ladder.test.ts packages/core/src/constitutions/index.test.ts packages/cli/src/cli/config-override-option.test.ts packages/cli/src/cli/ship-config-source.test.ts
      passWhen: all tests pass, including the new ones
    - command: npx vitest related --run packages/core/src/config/run-config-ladder.ts packages/core/src/constitutions/index.ts packages/cli/src/cli/config-override-option.ts packages/cli/src/cli/program.ts
      passWhen: the focused BUILD handoff command exits 0
    - command: bash scripts/verify.sh --no-e2e
      passWhen: the full gate is green (CHECK runs it before SHIP)
  riskBlastRadius: >-
    Every one-shot run goes through resolveRunConfigLadder and every constitution read goes through
    loadRepoConstitution. A mistake in the blank check or the rank order could change which config or constitution
    every run uses, including the factory's own self-build. The risk is limited because every new branch is gated
    on a non-blank FACTORY_PROJECT_CONFIG_DIR, and the existing run-config-ladder tests stay unedited as a
    regression guard. The container job path (job.ts) does not mount the external directory. That is out of
    scope, and a host path given to a container job would fail loud as a missing directory, never silently.
  openQuestions:
    - >-
      The issue names tests/config/project-config-ladder.spec.ts and tests/config/project-config-validation.spec.ts,
      but vitest only collects packages/*/src/**/*.test.ts, and the constitution requires colocated tests. The
      same test names go into packages/core/src/config/project-config-ladder.test.ts,
      packages/cli/src/cli/config-override-option.test.ts and packages/cli/src/cli/ship-config-source.test.ts.
    - >-
      Assumed: a project directory missing config.yaml (or constitution.md) is an error naming the source and the
      file. It does not fall back to the repo file or to defaults. A human may prefer a lenient fallback.
    - >-
      The `factory: config:` line and the doctor config-sources row are out of scope. describeConfigSources already
      renders any non-repo source generically, so the config half will read `--project-config (<dir>/config.yaml)`
      with no format change. constitutionSourceLabel is left unchanged, so the constitution half still reads
      .factory/constitution.md or the fallback label even when the external constitution.md is used. A follow-up
      should correct that label.
  evidencePlan:
    - kind: fail-to-pass-test
      claim: >-
        The external directory replaces the repo files at rank 3. With FACTORY_PROJECT_CONFIG_DIR set and both repo
        .factory files present, resolveRunConfigLadder returns the external config (its own disk.minFreeGb value,
        source FACTORY_PROJECT_CONFIG_DIR, path <dir>/config.yaml) and ConstitutionLoader.loadRepoConstitution
        returns the external constitution body.
      test: packages/core/src/config/project-config-ladder.test.ts "external source replaces repo file at rank 3"
    - kind: fail-to-pass-test
      claim: >-
        Every combination resolves in the documented order. A table over {project dir set/unset} x
        {--config, FACTORY_CONFIG_PATH, FACTORY_CONFIG_YAML, none} x {FACTORY_CONFIG_OVERRIDES set/unset} x
        {repo file present/absent} asserts the expected source label and merged value. A second table over
        {project dir} x {--constitution, FACTORY_CONSTITUTION_PATH, FACTORY_CONSTITUTION, none} x {repo
        constitution present/absent} asserts which body loadRepoConstitution returns.
      test: packages/core/src/config/project-config-ladder.test.ts "ladder matrix"
    - kind: command
      claim: >-
        No external source means no behavior change. The existing ladder and constitution specs pass unedited.
      command: npx vitest run packages/core/src/config/run-config-ladder.test.ts packages/core/src/constitutions/index.test.ts packages/cli/src/cli/config-override-option.test.ts packages/cli/src/cli/ship-config-source.test.ts
      passWhen: exit 0, and `git diff main -- packages/core/src/config/run-config-ladder.test.ts packages/core/src/constitutions/index.test.ts` is empty
      expect:
        exitCode: 0
    - kind: fail-to-pass-test
      claim: >-
        An invalid external config.yaml fails before PLAN. With FACTORY_PROJECT_CONFIG_DIR pointing at a directory
        whose config.yaml has an unknown top-level key, shipIssue rejects with a message containing the directory
        path and 'config.yaml'. planPhase is not called and FACTORY_RUN_CONFIG_JSON stays unset.
      test: packages/cli/src/cli/ship-config-source.test.ts "invalid external config.yaml names source and file"
    - kind: fail-to-pass-test
      claim: >-
        The flag wins over the env var. With env FACTORY_PROJECT_CONFIG_DIR=dirA, applyConfigOverrideOptions({
        projectConfig: dirB }) sets the env to the absolute dirB with source '--project-config', and
        resolveRunConfigLadder then returns dirB's config with source '--project-config'.
      test: packages/cli/src/cli/config-override-option.test.ts "flag wins over env var"
  outline:
    - result: >-
        The core ladder resolves the project directory at rank 3 for config and constitution, validates the
        external config strictly, and names the source and file on errors.
      files:
        - packages/core/src/config/run-config-ladder.ts
        - packages/core/src/constitutions/index.ts
        - packages/core/src/config/project-config-ladder.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/config/project-config-ladder.test.ts packages/core/src/config/run-config-ladder.test.ts packages/core/src/constitutions/index.test.ts
      manualChecks: []
    - result: >-
        `factory --project-config <dir>` sets the env for the whole run, beats the env var, exits 2 on a missing
        directory, and an invalid external config stops shipIssue before PLAN.
      files:
        - packages/cli/src/cli/config-override-option.ts
        - packages/cli/src/cli/program.ts
        - packages/cli/src/cli/config-override-option.test.ts
        - packages/cli/src/cli/ship-config-source.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli/config-override-option.test.ts packages/cli/src/cli/ship-config-source.test.ts
      manualChecks:
        - factory --help lists --project-config <dir>
    - result: The changelog and the config-overrides runbook document the new source and the full ladder order.
      files:
        - CHANGELOG.md
        - docs/runbooks/config-overrides.md
      automatedChecks:
        - npx prettier --check CHANGELOG.md docs/runbooks/config-overrides.md
      manualChecks: []
  edgeInputs:
    - FACTORY_PROJECT_CONFIG_DIR unset
    - FACTORY_PROJECT_CONFIG_DIR empty string or whitespace only
    - FACTORY_PROJECT_CONFIG_DIR relative path (resolved against process.cwd())
    - FACTORY_PROJECT_CONFIG_DIR pointing at a non-existent path or a regular file
    - project directory without a config.yaml / config.yml / config.json
    - project directory with both config.yaml and config.json (ambiguity)
    - project config.yaml with malformed YAML, a non-mapping document, or an unknown key
    - project directory without constitution.md, or with an empty one
    - FACTORY_PROJECT_CONFIG_DIR_SOURCE set to anything other than '--project-config'
    - --project-config given with a missing directory
  behaviorDelta:
    - input: FACTORY_PROJECT_CONFIG_DIR unset or blank
      branch: pickWinner falls through to the repo file, then packaged defaults; loadRepoConstitution reads the repo instance
      before: repo file, then packaged defaults; repo constitution, then fallback
      after: identical
      verdict: same
    - input: project directory set, no explicit config override
      branch: new rank-3 branch in pickWinner
      before: env var ignored; the repo .factory/config.yaml was used
      after: <dir>/config.yaml is used and always strictly validated, with source FACTORY_PROJECT_CONFIG_DIR or --project-config
      verdict: better
    - input: project directory set together with --config / FACTORY_CONFIG_PATH / FACTORY_CONFIG_YAML
      branch: the earlier branches in pickWinner win
      before: explicit override used
      after: explicit override used; the project directory is not read for config
      verdict: same
    - input: project directory set together with FACTORY_CONFIG_OVERRIDES
      branch: overrides deep-merge over the rank-3 winner
      before: overrides merged over the repo file
      after: overrides merged over the external config
      verdict: better
    - input: project directory set, no constitution override
      branch: new resolveProjectConstitution branch in loadRepoConstitution
      before: repo .factory/constitution.md or null
      after: <dir>/constitution.md, with repoInstance pointing at it
      verdict: better
    - input: project directory set together with --constitution / FACTORY_CONSTITUTION_PATH / FACTORY_CONSTITUTION
      branch: the resolveConstitutionOverride branch returns first
      before: override used
      after: override used
      verdict: same
    - input: project path missing or not a directory, or a file missing from it
      branch: throws in resolveProjectConfigDir / pickWinner / resolveProjectConstitution
      before: n/a (env var ignored)
      after: throws `<source>: ...` naming the directory and the file; shipIssue rejects before PLAN; the CLI flag exits 2
      verdict: better
    - input: FACTORY_PROJECT_CONFIG_DIR_SOURCE has any value other than '--project-config'
      branch: label defaults to FACTORY_PROJECT_CONFIG_DIR
      before: n/a
      after: label FACTORY_PROJECT_CONFIG_DIR (mirrors FACTORY_CONFIG_PATH_SOURCE handling)
      verdict: same
  externalLists:
    - name: ConfigSourceLabel
      location: packages/core/src/config/run-config-ladder.ts ConfigSourceLabel
      source: internal union, checked against job.ts and doctor-config-sources.ts usages in this checkout
      gaps: []
    - name: REPO_CONFIG_FILENAMES
      location: packages/core/src/config/repo-config-file.ts REPO_CONFIG_FILENAMES
      source: in-repo constant (config.yaml, config.yml, config.json); reused unchanged through resolveRepoConfigPath
      gaps: []
---
# Spec: config: resolve --project-config / FACTORY_PROJECT_CONFIG_DIR as rank 3 for config.yaml and constitution.md (#4338)

## Goal

Let an operator point a run at a project config directory outside the checkout. The directory is set with
`--project-config <dir>` or `FACTORY_PROJECT_CONFIG_DIR`, and the flag wins. Its `config.yaml` and
`constitution.md` replace the repo's `.factory/config.yaml` and `.factory/constitution.md` at rank 3 of the
existing ladder (#3906). Every higher override keeps its rank, and `FACTORY_CONFIG_OVERRIDES` still merges on top.
Runs without the new source behave exactly as before. A bad external config fails loud before PLAN, naming the
source and the file.

Resulting order, highest first:

- **Config:** `FACTORY_CONFIG_OVERRIDES` (merged on top of the winner) > `--config` > `FACTORY_CONFIG_PATH` >
  `FACTORY_CONFIG_YAML` > **project directory** (`--project-config` > `FACTORY_PROJECT_CONFIG_DIR`) > repo
  `.factory/config.yaml` > packaged defaults.
- **Constitution:** `--constitution` > `FACTORY_CONSTITUTION_PATH` > `FACTORY_CONSTITUTION` > **project
  directory** > repo `.factory/constitution.md` > instruction files or bundled.

## Files / approach

### 1. `packages/core/src/config/run-config-ladder.ts`

1. Extend `ConfigSourceLabel` with `'--project-config' | 'FACTORY_PROJECT_CONFIG_DIR'`.
2. Add `export function resolveProjectConfigDir(env = process.env)`:
   - If `blank(env.FACTORY_PROJECT_CONFIG_DIR)`, return `undefined`.
   - Set `source` to `'--project-config'` when `env.FACTORY_PROJECT_CONFIG_DIR_SOURCE === '--project-config'`,
     otherwise `'FACTORY_PROJECT_CONFIG_DIR'`.
   - Set `dir = resolve(env.FACTORY_PROJECT_CONFIG_DIR)` (from `node:path`).
   - If `!existsSync(dir) || !statSync(dir).isDirectory()`, throw `` `${source}: no such directory: ${dir}` ``.
   - Return `{ dir, source }`.
3. In `pickWinner`, after the `FACTORY_CONFIG_YAML` branch and before the repo read:
   - Call `const project = resolveProjectConfigDir(env)`.
   - If it is set: `const path = resolveRepoConfigPath(project.dir)` (import from `./repo-config-file.js`), then
     `const raw = readRepoConfigFile(path)`.
   - If `raw === undefined`, throw `` `${project.source}: no config.yaml in ${project.dir}` ``.
   - Otherwise return `{ raw, source: project.source, path }`.
4. In `resolveRunConfigLadder`, the non-mapping check and the schema-issue throw must include the file for
   project sources. Build `const where = path !== undefined && (source === '--project-config' || source === 'FACTORY_PROJECT_CONFIG_DIR') ? ` (${path})` : ''`
   and use `` `Invalid ${source}${where}: …` `` in both throws. Existing labels and messages stay byte-identical
   because `where` is `''` for them. The project source is never `'repo'`, so the existing
   `if (source !== 'repo' || …)` validation always runs for it, with no new branch.
5. Add `export function resolveProjectConstitution(env = process.env)`:
   - Call `resolveProjectConfigDir(env)`, and return `undefined` if it is unset.
   - Set `path = join(dir, 'constitution.md')`.
   - If the file is missing, throw `` `${source}: no constitution.md in ${dir}` ``.
   - Read it the same way `resolveConstitutionOverride` reads its file, throwing on a read error with the source
     and path.
   - If it is empty, throw `` `${source}: constitution file is empty: ${path}` ``.
   - Return `{ text, source, path }`.
   - Reuse a small shared helper with `resolveConstitutionOverride`'s file read if that avoids duplication (the
     duplication baseline must not grow).
6. Update the header doc comment's ladder list only if anti-slop allows it. It is an existing comment, and
   comments must not grow. Prefer leaving it and documenting the ladder in the runbook.

### 2. `packages/core/src/constitutions/index.ts`

- In `ConstitutionLoader.loadRepoConstitution`, after the `resolveConstitutionOverride()` block, call
  `const project = resolveProjectConstitution()`.
- If it is set, return
  `{ ...parseConstitution(project.text, project.path, 'repo-override'), repoInstance: { relPath: project.path, absPath: project.path } }`.
- Import the function from `../config/run-config-ladder.js`.

### 3. `packages/cli/src/cli/config-override-option.ts`

- Widen the `flags` parameter to `{ config?: string; constitution?: string; projectConfig?: string }`.
- When `flags.projectConfig !== undefined`:
  - Set `abs = resolve(cwd, value)`.
  - If `!existsSync(abs) || !statSync(abs).isDirectory()`, throw `` `--project-config: no such directory: ${abs}` ``.
  - Set `env.FACTORY_PROJECT_CONFIG_DIR = abs` and `env.FACTORY_PROJECT_CONFIG_DIR_SOURCE = '--project-config'`.
- Overwriting the env var is what makes the flag win over an inherited value, and the env reaches every lane and
  CHECK subprocess.
- Leave `constitutionSourceLabel` and `reportConfigSource` unchanged (out of scope).

### 4. `packages/cli/src/cli/program.ts`

Add a global option after `--constitution`:

```ts
.option('--project-config <dir>', 'Read config.yaml and constitution.md from this directory instead of .factory/; env FACTORY_PROJECT_CONFIG_DIR; --config / --constitution and their env vars still win')
```

In the preAction hook, read `projectConfig` from `program.opts()` and pass it to `applyConfigOverrideOptions`.
The existing try/catch already turns a throw into `CliExitError(…, 2)`.

### 5. Docs

- `CHANGELOG.md`, `## Unreleased` → `### Added`: "`--project-config <dir>` / `FACTORY_PROJECT_CONFIG_DIR` read
  `config.yaml` and `constitution.md` from a directory outside the checkout, ranked below `--config` /
  `FACTORY_CONFIG_*` and the constitution overrides (#4338)".
- `docs/runbooks/config-overrides.md`: add the new source and the full ladder order for config and
  constitution. State that a missing directory or file and an invalid config fail before PLAN, naming the
  source and the file. State that the container job path does not mount the directory.

### Notes

- No ADR, no schema change, no new config keys.
- No changes to `job.ts`, `doctor-config-sources.ts` or `describeConfigSources`. The config half of the
  `factory: config:` line renders the new label through its existing generic branch.

## Tests

Use `createTempDirs` from `../harness/temp-dir.js` (core) and `vi.stubEnv` with `vi.unstubAllEnvs` in `afterEach`.

- **New: `packages/core/src/config/project-config-ladder.test.ts`**
  - `'external source replaces repo file at rank 3'`:
    - Set up a repo with `.factory/config.yaml` (`disk.minFreeGb: 10`) and `.factory/constitution.md` ("Repo
      standards").
    - Set up an external directory with `config.yaml` (`disk.minFreeGb: 3`) and `constitution.md` ("Project
      standards").
    - Stub `FACTORY_PROJECT_CONFIG_DIR`.
    - Assert `resolveRunConfigLadder(repoConfigPath, process.env)` gives `source === 'FACTORY_PROJECT_CONFIG_DIR'`,
      `path === join(dir, 'config.yaml')` and `raw.disk.minFreeGb === 3`.
    - Assert `new ConstitutionLoader().loadRepoConstitution(repoDir)?.body` contains "Project standards", and
      `repoInstance.absPath` is the external file.
  - `'ladder matrix'`:
    - Config table: loop over project {unset, set} × explicit {none, `--config` (`FACTORY_CONFIG_PATH` plus
      `_SOURCE=--config`), `FACTORY_CONFIG_PATH`, `FACTORY_CONFIG_YAML`} × overrides {unset, `disk:\n  minFreeGb: 7\n`}
      × repo file {present, absent}.
    - Each source carries a distinct `disk.minFreeGb`. Assert the expected `source` and value: 7 whenever
      overrides are set, otherwise the winner's value.
    - The packaged-defaults case with nothing set gives `raw === undefined`.
    - Constitution table: loop over project {unset, set} × override {none, `--constitution`,
      `FACTORY_CONSTITUTION_PATH`, `FACTORY_CONSTITUTION`} × repo constitution {present, absent}.
    - Assert which body `loadRepoConstitution` returns. The repo-absent, project-unset, override-none case gives
      `null`.
  - Error cases:
    - A blank or whitespace env var is ignored.
    - A missing directory throws, naming `FACTORY_PROJECT_CONFIG_DIR` and the path.
    - A directory without `config.yaml` throws, naming the directory and `config.yaml`.
    - A missing or empty `constitution.md` throws, naming `constitution.md`.
    - A non-mapping `config.yaml` throws `Invalid FACTORY_PROJECT_CONFIG_DIR (<dir>/config.yaml)`.
- **`packages/cli/src/cli/config-override-option.test.ts`** (add, do not edit existing tests):
  - `'flag wins over env var'`:
    - Create dirA and dirB, each with a valid `config.yaml` carrying distinct values.
    - Set the env object `FACTORY_PROJECT_CONFIG_DIR=dirA`.
    - Call `applyConfigOverrideOptions({ projectConfig: dirB }, cwd, env)`.
    - Assert the env holds the absolute dirB and `_SOURCE=--project-config`.
    - Assert `resolveRunConfigLadder(<nonexistent repo path>, env)` returns dirB's value with source
      `'--project-config'`. Import it from `@on-par/factory-core/internal` if it is exported there; otherwise
      assert on the env only and keep the resolver assertion in the core test.
  - A missing `--project-config` directory throws, and the program exits 2. Mirror the existing `--config` tests.
- **`packages/cli/src/cli/ship-config-source.test.ts`** (add):
  - `'invalid external config.yaml names source and file'`:
    - Create an external directory whose `config.yaml` is `bogusTopLevel: 1\n`, and stub
      `FACTORY_PROJECT_CONFIG_DIR`.
    - Assert `shipIssue(5, {})` rejects with a message containing the directory path and `config.yaml`.
    - Assert `phases.planPhase` was not called and `process.env.FACTORY_RUN_CONFIG_JSON` is undefined.
- Existing `run-config-ladder.test.ts`, `constitutions/index.test.ts` and the existing tests in the two CLI
  files stay unedited. They are the no-regression proof.

Commands:

- Focused handoff: `npx vitest related --run packages/core/src/config/run-config-ladder.ts packages/core/src/constitutions/index.ts packages/cli/src/cli/config-override-option.ts packages/cli/src/cli/program.ts`
- Direct: `npx vitest run packages/core/src/config/project-config-ladder.test.ts packages/cli/src/cli/config-override-option.test.ts packages/cli/src/cli/ship-config-source.test.ts`
- Full gate (CHECK): `bash scripts/verify.sh --no-e2e`

## Constitution compliance

- **Verify gate:** BUILD runs the focused `tests.affected` command and reports that the full gate is pending.
  CHECK runs `bash scripts/verify.sh --no-e2e`. No thresholds are lowered. If coverage rises, raise the
  threshold in the same PR.
- **Tests:** Each changed source file gets a colocated test: `project-config-ladder.test.ts` for
  run-config-ladder.ts and constitutions/index.ts, `config-override-option.test.ts`, and
  `ship-config-source.test.ts` for the program/ship path. Every new test fails without the change. No test is
  skipped or deleted, and the existing ladder specs stay unedited.
- **No comments:** No new comments are added, and `comments-baseline.json` does not grow.
- **Architecture:**
  - The resolver lives in core and the flag in cli, so `config ← core ← cli` holds.
  - The cli imports core only through `@on-par/factory-core/internal`.
  - Relative imports use `.js` extensions.
  - No model ids are touched.
  - No ADR is needed. This adds a rung to the existing #3906 ladder and makes no new architectural decision.
- **Domain terms:** The spec says run, lane and park with their CONTEXT.md meanings. "Project config directory"
  is the new source's name.
- **Docs and release hygiene:** The PR adds a `## Unreleased` → `### Added` line ending in (#4338) and updates
  `docs/runbooks/config-overrides.md`. No `package.json` version edits. `docs/config.example.yaml` is untouched,
  since there are no new keys.
- **Safety:**
  - Errors name paths and labels only, never config values.
  - Override keys stay redacted through the existing path.
  - No shell is built from inputs.
  - No guardrails are weakened. External config is validated with the same strict schemas, and it is stricter
    than the repo file because it is always validated.
- **ADR-0160:** This is a new opt-in source, not a tightening of validation for config that passes today, so it
  needs no warn stage. Runs without the source are unchanged.
- **ADR-0169:** The project config flows through the same `holdRunConfigSnapshot` channel, so CHECK in a
  worktree sees the same snapshot.

## Non-goals

- Reading agent-memory, product or tests from the external directory.
- Changing the `factory: config:` line format, the `config_source` event, `constitutionSourceLabel` or the
  `factory doctor` output.
- Mounting the directory into container jobs (`job.ts`).
- Fetching config from a URL or a remote service.
- Adding config keys or changing schemas.
