---
product: 'camp-somewhere-cli'
version: 1
checkers: []
enforced_on: [plan, build, check]
requireTests: true
---

# Camp Somewhere CLI Constitution

## Purpose

Camp Somewhere is a .NET command-line tool for finding campsite availability quickly and accurately, starting with Texas State Parks on the ReserveAmerica-backed site. It is intended to become a public installable CLI, so every change must preserve user trust: correct availability data, boring installation, explicit failure modes, and a small supply-chain surface.

## Standards

### Feature-Oriented Structure

Organize code by feature name, not generic layer names. A feature owns its command parsing, domain model, provider boundary, formatting, and tests. Keep `Availability` as the current feature root unless an issue deliberately adds another feature.

### Type-Driven Design

Prefer typed concepts over loose booleans and strings when the domain can name them. Amenity filters, provider identities, status values, and future provider capabilities should use enums, records, or typed collections where that gives the compiler useful structural feedback.

### Provider Safety

Provider code must be defensive. Scraped totals, page counts, response sizes, and parsed identities are untrusted input. Add explicit caps and clear errors before adding any new provider behavior that could cause unbounded requests, memory growth, or silent data corruption.

### Availability Correctness

Never return an availability result unless every requested night was actually evaluated. Date-window logic must cover week boundaries and longer stays. Site identity must use provider IDs when available and a stable fallback only when provider IDs are absent.

### CLI UX

The user-facing command is `camp-somewhere`. The CLI should support standard affordances expected from a Homebrew-installed tool: help, version, discoverable supported parks, clear no-result messages, shell-friendly exit codes, and copyable booking links.

### Testing and Coverage

All included application code must maintain 100% line coverage and 100% branch coverage. Coverage tests must prove public behavior, not merely hit private fallback branches. Parser tests should use focused fixtures for malformed HTML, duplicate site numbers, missing fields, unrelated links, and cross-window date spans.

### Supply-Chain Hygiene

Runtime dependencies should stay minimal. Test-only dependencies must be current, non-deprecated, and justified by an actual test. CI must use least-privilege permissions, pinned actions, locked NuGet restore, vulnerability audits, and Dependabot weekly checks before release/tap packaging.

## Quality Gates

- `dotnet restore` must be reproducible once lock files are introduced.
- `dotnet build` must pass with warnings treated as errors.
- `dotnet test` must pass.
- Coverage must remain at 100% line and 100% branch for included application code once issue #6 lands.
- CI must produce Cobertura coverage output.
- `dotnet list package --vulnerable --include-transitive` must report no vulnerable packages.
- `dotnet list package --deprecated` must report no deprecated packages once issue #9 lands.

## Dispute Rules

When worker and checker disagree, prefer the safer interpretation of user-facing correctness and supply-chain risk. If a change can silently misreport campsite availability, overfetch a provider, weaken CI, or reduce type clarity, the checker should block until the issue acceptance criteria are satisfied or the issue is explicitly narrowed.

## Non-Goals

- Do not implement booking or login automation during this hardening queue unless an issue explicitly asks for it.
- Do not add more campground providers during this queue.
- Do not package to Homebrew or npm until the hardening issues that protect the release path have landed.
- Do not replace the .NET CLI with another runtime.
