# Sandbox egress

Under `sandbox-exec` (macOS) with a non-empty `sandbox.network.allow`, each lane's agent traffic goes through a local report-only proxy. The proxy logs every host it sees (`egress_host`) and a per-run summary (`egress_summary`). The allowlist is not enforced yet: hosts that are not on it are still forwarded and reported. Mini egress is currently report-only; enforce mode is tracked in #2215.

An empty `sandbox.network.allow` denies all egress, and the proxy does not run.

## Per-ecosystem registry defaults

Registry hosts are pre-allowed only for ecosystems detected in the repo root, and only when `sandbox.network.allow` is non-empty.

| Ecosystem        | Detected when the repo root has                           | Hosts added                                  |
| ---------------- | --------------------------------------------------------- | -------------------------------------------- |
| Node (npm, yarn) | a `package.json` file                                     | `registry.npmjs.org`, `registry.yarnpkg.com` |
| .NET (NuGet)     | a `.sln`, `.slnx`, `.csproj`, `.fsproj` or `.vbproj` file | `api.nuget.org`, `*.nuget.org`               |

Notes:

- A repo with both gets both sets of hosts.
- Detection looks at the repo root only, not subdirectories.
- `*.nuget.org` matches subdomains, not `nuget.org` itself.
- Hosts already on your list are not duplicated.
- To allow any other registry (private feeds, pnpm mirrors, and so on), add it to `sandbox.network.allow`. Use an exact host or a `*.suffix` pattern.

```yaml
# .factory/config.yaml
sandbox:
  network:
    allow:
      - api.anthropic.com
      - github.com
      - npm.internal.example.com
```

## Telemetry hosts

Known vendor telemetry hosts are classified separately from other unlisted hosts:

- `datadoghq.com`
- `*.datadoghq.com`
- `datadoghq.eu`
- `*.datadoghq.eu`

The `egress_host` log line marks them, for example `app.datadoghq.com (telemetry, not on allowlist)`. The `egress_summary` line counts them in their own group, for example `3 host(s) used, 1 not on allowlist: example.org; 1 telemetry not on allowlist: app.datadoghq.com`.

### Blocking telemetry

Set `sandbox.network.blockTelemetry` to `true` to refuse telemetry hosts. The default is `false`.

```yaml
# .factory/config.yaml
sandbox:
  network:
    blockTelemetry: true
```

When it is on, the proxy answers telemetry hosts with HTTP 403, even if they are on the allowlist. Blocked hosts are still logged. It only takes effect where the proxy runs: `sandbox-exec` with a non-empty allowlist.
