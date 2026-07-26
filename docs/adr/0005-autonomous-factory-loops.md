# ADR-0005: Autonomous factory loops — auto-failover, self-healing, and discovery

- Status: Proposed
- Date: 2026-07-20

## Context

The factory (ADR-0001) ships a queue it is given. Three gaps keep it from
running unattended for long stretches:

1. **Quota cliffs.** The coding worker is preferred (and often pinned) to a
   Codex-harness model such as GPT-5.6 Terra. When the ChatGPT/Codex account
   hits its usage cap or a rate limit, `ModelRouter.resolveAll()` applies a hard
   `requires: codex` filter to the build route, so the only failover targets are
   other Codex-harness models on the same exhausted quota. The lane parks. The
   only recovery today is a manual `FACTORY_CODEX=0` flip.
2. **Silent faults.** Genuine defects (unhandled exceptions, checker crashes,
   reproducible escalations, repeated identical parks) land in
   `.factory/events.ndjson` and are forgotten. Nothing turns them into tracked,
   fixable work.
3. **Empty queue.** When the backlog drains, the factory idles. Nothing
   generates grounded new work.

## Decision

Add three capabilities, each scoped as an epic of INVEST stories in
`on-par/software-factory`:

- **Auto-failover Terra to Sonnet on quota exhaustion — epic #366** (#367 cross-harness
  build failover, #368 precise usage-cap/rate-limit classification, #369
  supervisor circuit breaker + cooldown + config + observability). On a genuine
  quota/rate-limit signal with no Codex worker left, a codex-routed build
  continues on the Claude fallback (Sonnet 5); a breaker keeps other lanes off
  the dead provider for a cooldown window.
- **Self-healing loop — epic #370** (#372 failure fingerprint + evidence capture,
  #373 auto-file a bug with dedup + repo routing, #374 filing policy, rate caps,
  and a human gate for factory-self-fixes). Real defects are fingerprinted,
  deduplicated against open issues, and filed as `bug` for the factory to fix.
- **Discovery loop — epic #371** (#375 discovery scan of product signals, #376
  draft-Epic authoring + lifecycle labels + in-issue owner questions, #377
  in-issue dialogue to validation, then decompose into buildable stories).
  Communication is GitHub-only: the owner steers each idea from inside the Epic
  issue. Nothing becomes buildable work until the owner marks it validated.

Model posture in force (2026-07-20): boss/planner Opus 4.8, coding worker
GPT-5.6 Terra High, Sonnet 5 as the Claude-route worker and the failover target.

### Architecture

```mermaid
graph TB
    subgraph GH["GitHub (on-par/&lt;repo&gt;)"]
        ISS["Issues"]
        PR["Pull Requests + CI"]
    end

    subgraph SUP["Supervisor (factory supervise)"]
        WD["Usage watchdog<br/>(trailing-5h cap, resume gate)"]
        Q[".factory/queue<br/>lanes = parallel<br/>issues in lane = sequential"]
        LANES["Parallel lanes"]
    end

    subgraph PIPE["Per-issue pipeline (isolated worktree)"]
        PLAN["PLAN<br/>boss picks scope + route"]
        BUILD["BUILD<br/>from frozen spec"]
        CHECK["CHECK<br/>compile / tests / lint / review"]
        SHIP["SHIP<br/>open PR, watch CI, merge"]
    end

    subgraph ROUTER["ModelRouter + failover (config-driven)"]
        BOSS["boss tier<br/>Opus 4.8 -> Sonnet 5"]
        WORKER["worker tier<br/>Terra High (codex) | Sonnet 5 (claude)"]
        CHK["checker tier<br/>Sonnet / local"]
    end

    subgraph HARNESS["Harnesses"]
        CC["claude-cli"]
        CX["codex-cli"]
        OL["ollama"]
    end

    OBS[".factory/events.ndjson<br/>+ per-issue logs"]

    subgraph LOOPS["Autonomous loops (roadmap)"]
        SH["Self-healing #370<br/>fingerprint -> dedup -> file bug"]
        DISC["Discovery #371<br/>scan signals -> draft Epic -> decompose"]
    end

    ISS --> Q
    Q --> LANES --> PLAN --> BUILD --> CHECK --> SHIP --> PR
    WD -. gates .-> LANES
    PR -- merged --> ISS

    PLAN --- BOSS
    BUILD --- WORKER
    CHECK --- CHK
    BOSS --- CC
    WORKER --- CX
    WORKER --- CC
    CHK --- OL

    PIPE -- emits --> OBS
    OBS --> SH -- files bug --> ISS
    ISS -. product signals .-> DISC -- owner validates in-issue --> DISC
    DISC -- buildable stories --> Q

    classDef roadmap fill:#fff3cd,stroke:#b60205,color:#000;
    class SH,DISC roadmap;
```

### End-to-end flow

```mermaid
flowchart TD
    START(["Issue enters .factory/queue"]) --> PLAN["PLAN — Opus 4.8<br/>freeze spec, pick route"]
    PLAN --> ROUTE{"route?"}

    ROUTE -- "codex (bounded)" --> BTERRA["BUILD on Terra High<br/>(codex-cli)"]
    ROUTE -- "claude (UX/judgment)" --> BSONNET["BUILD on Sonnet 5<br/>(claude-cli)"]

    BTERRA --> QCHK{"worker failed on<br/>usage_cap / rate_limit?"}
    QCHK -- "no (built ok)" --> CHECK
    QCHK -- "yes, codex exhausted<br/>(#367 + #369)" --> BSONNET
    BSONNET --> CHECK["CHECK<br/>compile / tests / lint / review"]

    CHECK --> PASS{"green?"}
    PASS -- "no, rework" --> BTERRA
    PASS -- "yes" --> SHIP["SHIP<br/>open PR, watch CI"]
    SHIP --> MERGE{"CI green + review ok?"}
    MERGE -- "yes" --> DONE(["Merged -> next issue in lane"])
    MERGE -- "review-required" --> AWAIT["awaiting-review<br/>(not a park)"]

    PLAN -. genuine defect .-> ERR["Error / escalation / repeated park"]
    BTERRA -. genuine defect .-> ERR
    CHECK -. genuine defect .-> ERR
    ERR --> FP["Self-healing #370:<br/>fingerprint + evidence"]
    FP --> DEDUP{"open issue with<br/>same fingerprint?"}
    DEDUP -- "yes" --> BUMP["comment + bump count"]
    DEDUP -- "no" --> FILE["file bug (routed repo)"]
    FILE --> START

    subgraph DISCOVERY["Discovery loop #371 (GitHub-only, scheduled)"]
        SCAN["scan constitution / issues / TODOs / bug themes"] --> EPIC["draft Epic<br/>hypothesis + open questions"]
        EPIC --> OWNER{"owner validates<br/>in-issue?"}
        OWNER -- "needs-work" --> EPIC
        OWNER -- "wontfix" --> ARCH["archived"]
        OWNER -- "validated" --> DECOMP["decompose into INVEST stories"]
    end
    DECOMP --> START

    classDef roadmap fill:#fff3cd,stroke:#b60205,color:#000;
    class QCHK,FP,DEDUP,BUMP,FILE,SCAN,EPIC,OWNER,DECOMP,ARCH roadmap;
```

## Consequences

- The factory can absorb a mid-run quota cliff without parking every codex lane,
  can convert its own recurring faults into tracked bugs, and can refill its
  backlog from grounded signals with the owner as the gate.
- New failure mode to guard: the self-healing loop touches the tracker and the
  discovery loop touches the backlog, so both need caps and dedup, and any
  fix that modifies factory core, the merge path, or security is human-gated
  (see #374). This ADR is Proposed until #366/#370/#371 land.
- Self-healing depends on #368/#272 for clean signals, so it sequences after the
  failover classification work. Discovery is independent.
