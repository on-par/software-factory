# @on-par/factory-cli

The `factory` command for On PAR Dev's Software Factory.

On PAR Dev's Software Factory is a local CLI that takes a GitHub issue through plan, build and check with AI agents, then opens a ready-for-review PR. You decide what merges.

Built in TypeScript. Routes work across Claude and Codex, with experimental local models through Ollama, and logs cost per task.

![On PAR Dev's Software Factory running a Sound Buddy lane (sped up)](https://raw.githubusercontent.com/on-par/software-factory/main/docs/assets/factory-run.gif)

## Install

```bash
npm install -g @on-par/factory-cli   # Requires Node.js 24 or newer
factory --version
factory doctor
```

Also requires `git`, one supported coding agent CLI (see [docs/agents.md](https://github.com/on-par/software-factory/blob/main/docs/agents.md)), signed in, and the GitHub CLI signed in with `gh auth login`. The factory reads `GITHUB_TOKEN`, then `GH_TOKEN`, and falls back to `gh auth token`. `factory doctor` checks all of this and prints a fix for anything missing. It also checks your git identity and the sandbox runtime, and it runs outside a repo. Global or repo-local `git config` for `user.name` and `user.email` both work. On Linux, install `firejail` first: without it, Codex runs with `--sandbox danger-full-access`.

`factory init` creates a local-only `.factory/` (git-excluded) with a `default-code` constitution. See the main README quick start.

## Safety

Agents run with their permission prompts off (Claude Code with `--permission-mode bypassPermissions`, Codex with `approval_policy=never`) in a separate git worktree under `~/.factory/worktrees/<owner>/<repo>/`, with your permissions and your GitHub token. Only point the factory at repos and issues you trust. It never merges by default: `factory run` and `factory supervise` merge only if you turn auto-merge on (`FACTORY_MERGE=1`, `run.merge.auto: true`, or `--auto-merge`), and `factory land` merges when you run it. Details are in the [Safety section](https://github.com/on-par/software-factory#safety) and [SECURITY.md](https://github.com/on-par/software-factory/blob/main/SECURITY.md).

## Updating

```bash
npm install -g @on-par/factory-cli@latest
```

`factory self-update --check` reports whether a newer release is on npm. It works in 0.9.3 and later. Automatic updates are planned: [#2355](https://github.com/on-par/software-factory/issues/2355), [#1939](https://github.com/on-par/software-factory/issues/1939).

## Documentation

- [README and quick start](https://github.com/on-par/software-factory#readme)
- [Architecture and package graph](https://github.com/on-par/software-factory/blob/main/docs/architecture.md)
- [Changelog](https://github.com/on-par/software-factory/blob/main/CHANGELOG.md)

## License

MIT. See [LICENSE](./LICENSE).
