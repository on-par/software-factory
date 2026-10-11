# @on-par/factory-cli

The `factory` command for On PAR Dev's Software Factory.

On PAR Dev's Software Factory is a local CLI that takes a GitHub issue through plan, build and check with AI agents, then opens a ready-for-review PR. You decide what merges.

Built in TypeScript. Routes work across Claude and Codex, with experimental local models through Ollama, and logs cost per task.

## Install

```bash
npm install -g @on-par/factory-cli
factory --version
factory doctor
```

Requires Node.js >= 24, `git`, Claude Code (`claude`) installed and signed in, and the GitHub CLI signed in with `gh auth login`. The factory reads `GITHUB_TOKEN`, then `GH_TOKEN`, and falls back to `gh auth token`. `factory doctor` checks all of this and prints a fix for anything missing.

## Safety

Agents run with their permission prompts off (Claude Code with `--permission-mode bypassPermissions`, Codex with `approval_policy=never`) in a separate git worktree, with your permissions and your GitHub token. Only point the factory at repos and issues you trust. It never merges by default: `factory run` and `factory supervise` merge only if you turn auto-merge on (`FACTORY_MERGE=1`, `run.merge.auto: true`, or `--auto-merge`), and `factory land` merges when you run it. Details are in the [Safety section](https://github.com/on-par/software-factory#safety) and [SECURITY.md](https://github.com/on-par/software-factory/blob/main/SECURITY.md).

## Updating

```bash
npm install -g @on-par/factory-cli@latest
```

Automatic updates are planned: [#2354](https://github.com/on-par/software-factory/issues/2354), [#2355](https://github.com/on-par/software-factory/issues/2355).

## Documentation

- [README and quick start](https://github.com/on-par/software-factory#readme)
- [Architecture and package graph](https://github.com/on-par/software-factory/blob/main/docs/architecture.md)
- [Changelog](https://github.com/on-par/software-factory/blob/main/CHANGELOG.md)

## License

MIT. See [LICENSE](./LICENSE).
