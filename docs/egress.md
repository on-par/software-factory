# Sandbox egress

Under `sandbox-exec` (macOS) with a non-empty `sandbox.network.allow`, each lane's agent traffic goes through a local report-only proxy. The proxy logs every host it sees (`egress_host`) and a per-run summary (`egress_summary`). By default (`report` mode) the allowlist is not enforced: hosts that are not on it are still forwarded and reported. Set `sandbox.network.mode: enforce` to enforce it (see below).

An empty `sandbox.network.allow` denies all egress, and the proxy does not run.

Allowlist entries are an exact host, `*.suffix` (subdomains only, never `suffix` itself), or `.suffix` (`suffix` and all its subdomains, e.g. `.nuget.org` matches `nuget.org` and `api.nuget.org` but not `nuget.org.example.com`).

## Enforce mode

Set `sandbox.network.mode: enforce` (or `FACTORY_SANDBOX_NETWORK=enforce`, which overrides the config; only the exact values `report` and `enforce` are honored) to make the allowlist a real control on `sandbox-exec`. The default is `report`.

- The Seatbelt profile denies all outbound network except loopback (where the lane proxy and leased dev servers listen) and the mDNSResponder socket (DNS).
- The proxy answers `403` to any host not on `sandbox.network.allow` and never connects upstream. It reports each refused host once per run as an `egress_denied` warn event.
- No `sandbox-degraded` warning is logged, and BUILD reports `net allowlist enforced`.

Known limits: git over ssh, other unix sockets (ssh-agent, docker.sock, gpg-agent), and tools that ignore `HTTPS_PROXY` lose network access. Loopback stays open. `firejail` and `docker-sandbox` are unchanged and `firejail` still logs `sandbox-degraded`.

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
