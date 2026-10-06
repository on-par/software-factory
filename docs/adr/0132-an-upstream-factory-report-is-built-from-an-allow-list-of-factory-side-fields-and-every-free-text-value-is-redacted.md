# ADR-0132: An upstream factory report is built from an allow-list of factory-side fields and every free-text value is redacted

- Status: Accepted
- Date: 2026-10-02

## Context

The factory repo is public, while the repos the factory works on are often private. Run evidence (EvidencePack) mixes factory facts with target-repo content: the repo slug, issue ids, log and test excerpts, local paths. #1809 will send factory-internal defects upstream with the operator's own GitHub auth, so whatever the report builder emits becomes public. A deny-list over the private bug body (ADR-0130/0131) cannot be made safe, because test names and file names have no reliable shape.

## Decision

Upstream reports are built only by `buildUpstreamReport` in `packages/core/src/filing/upstream.ts` and contain only: factory version and commit, phase, failure reason, component, fingerprint, error class and message, factory-package stack frames with package-relative paths, harness and model names, OS and Node version. The error message comes only from an `XxxError:`/`XxxException:` line, with quoted strings removed. Every free-text value passes `redactText` (`packages/core/src/filing/redact.ts`), which replaces repo slugs, branch names, paths, usernames, hostnames, emails, URLs and token/key-shaped strings with fixed placeholders. Excerpts, log paths, issue ids, diffs and issue titles/bodies are never included. The title starts with `[factory-report]` and the body ends with `<!-- factory-upstream-report v1 fp:<fingerprint> -->`; any format change bumps `v1`. `factory filing preview <run-id>` prints exactly what would be sent.

## Consequences

Reports are safe to publish by construction, and new fields must be added to the allow-list deliberately with a redaction test. Some useful context (failing test name, excerpt) is never available upstream, so triage may need the operator to share more by hand. Redaction can over-replace (e.g. "and/or" becomes `<path>`), which we accept in favour of not leaking.

References: issues #1858, #1809.
