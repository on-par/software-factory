<!-- factory-broll-demo -->

# @on-par/factory-cli

CLI for the Software Factory — ships verified GitHub issues via boss-worker-checker
orchestration (PLAN → BUILD → CHECK → SHIP).

## Usage

Install and run via the `factory` bin declared in `package.json`:

```bash
npm install
npm run build
node dist/cli.js --help
```

During development, run directly with `tsx`:

```bash
npm run dev -- --help
```

See the repository root [AGENTS.md](../../AGENTS.md) for full project context and conventions.
