# Security Policy

## Reporting a vulnerability

Do not open a public issue, PR, or discussion for a security problem.

Report it privately through GitHub private vulnerability reporting: open the repo's **Security** tab and choose **Report a vulnerability**, or go directly to <https://github.com/on-par/software-factory/security/advisories/new>. GitHub documents the flow in [Privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

Please include:

- The affected package or command (`@on-par/factory-cli`, `@on-par/factory-core`, `@on-par/factory-config`).
- The version or commit SHA.
- Steps to reproduce.
- The impact you expect.

The maintainers respond on a best-effort basis. There is no guaranteed response time.

## Supported versions

Fixes land on `main`. Only the latest `main` is supported.

## Elevated agent permissions

To run unattended, the factory invokes agent CLIs with permission checks disabled, for example `claude -p ... --dangerously-skip-permissions` and `codex exec --sandbox workspace-write --ask-for-approval never`. Other harnesses also run unattended.

Every build runs inside an isolated git worktree, never in your main checkout. Agent-authored code (tests, dependency installs, scripts) still executes there with your user's privileges and whatever credentials are in the environment, such as `GITHUB_TOKEN`.

Only run the factory against repos and issues you trust. Issue bodies are treated as untrusted input, but prompt injection cannot be fully prevented. Use the `sandbox` config (`runtime: auto | sandbox-exec | firejail | docker-sandbox | none`) for extra isolation where available.

## Merge is opt-in

Auto-merge is off by default (`merge.auto: false`). Pipelines end at a green, ready-for-review PR and merging stays with you.

```sh
FACTORY_MERGE=1        # enable autonomous squash-merge
FACTORY_MERGE_ADMIN=1  # separate opt-in: use admin privileges to merge through unmet requirements
```

Set `FACTORY_MERGE_ADMIN=1` only when you intend that.

## Scope

In scope: the published packages (`packages/cli`, `packages/core`, `packages/config`) and this repo's scripts and workflows.

Agents executing code in a worktree you pointed them at is the documented design and is not by itself a vulnerability. Escaping the worktree, leaking tokens, merging without the opt-in, or bypassing required checks is.
