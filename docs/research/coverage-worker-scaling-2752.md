# Coverage worker scaling: heap and wall-clock at 2, 4 and 8 workers (Issue #2752)

Date: 2026-10-13

## Context

The required full-suite coverage run (`npm run test`, which is
`NODE_OPTIONS=--max-old-space-size=16384 vitest run --coverage --maxWorkers=1`)
is fully serial. `vitest.config.ts` also sets `fileParallelism: false`, with a
comment saying the files are kept serial so the instrumented run stays within
CI's heap limit. Nobody had measured what parallel workers actually cost in
memory or save in time. This issue was decomposed from #2735 and produces those
numbers so a follow-up can change the default on evidence. It changes no config,
script or threshold.

## Machine

- Mac Mini, 10 cores (`hw.ncpu`=10), 16 GB RAM (`hw.memsize`=17179869184),
  Darwin 27.0.0 (arm64)
- Node v26.6.0, vitest 5.0.3 (installed version; the spec expected 5.0.4)
- Commit `255eec573e1169c3b50b8db8ca0ea97dea1b9e99` (main, plus this note)
- CI (`.github/workflows/ci.yml`, `ubuntu-latest`) has 4 vCPUs and 16 GB, so
  results above 4 workers do not carry over to CI.

## Method

`vitest.config.ts` sets `fileParallelism: false`, which forces one worker no
matter what `--maxWorkers` says. Every run therefore passes `--fileParallelism`
to override it for that run. Without it all three runs would be serial. Runs
were one at a time, never in parallel, after `rm -rf coverage`:

```bash
for W in 2 4 8; do
  rm -rf coverage
  uptime > .tmp/cov-w$W.log
  NODE_OPTIONS=--max-old-space-size=16384 /usr/bin/time -l \
    npx vitest run --coverage --fileParallelism --maxWorkers=$W \
    --logHeapUsage --reporter=verbose >> .tmp/cov-w$W.log 2>&1
  echo "exit=$?" >> .tmp/cov-w$W.log
done
```

`--reporter=verbose` is needed because the default reporter does not print the
`--logHeapUsage` lines. Peak heap is the largest `N MB heap used` value logged
for any test (per worker). "Largest process RSS" is `maximum resident set size`
from `time -l`.

The spec also asked for a 1-second `ps` sampler summing RSS across all vitest
processes. `ps` is denied in the factory sandbox (`operation not permitted`,
even with the sandbox override), so the first attempt recorded 0 and **peak
process-tree RSS was not measured**. As a stand-in, the table gives the largest
single-process RSS. An upper bound for the tree is workers x that value plus the
main process, which is at most about 5 GB at 8 workers, well inside the 4 GB
headroom rule below 16 GB. The more-than-one-fork check of the override was
likewise not done with `ps`; the speedup itself (below) shows the override
works, since the serial run would not get faster with `--maxWorkers`.

## Results

| Workers | Wall-clock | Peak heap/worker (MB) | Largest process RSS (GB) | Tree RSS (GB) | Exit | Tests passed/failed  | OOM | Timeouts | Load avg at start |
| ------- | ---------- | --------------------- | ------------------------ | ------------- | ---- | -------------------- | --- | -------- | ----------------- |
| 2       | 91.73 s    | 262                   | 0.50                     | not measured  | 0    | 9131 / 0 (1 skipped) | no  | 0        | 5.00              |
| 4       | 56.48 s    | 211                   | 0.50                     | not measured  | 0    | 9131 / 0 (1 skipped) | no  | 0        | 4.40              |
| 8       | 45.92 s    | 210                   | 0.61                     | not measured  | 0    | 9131 / 0 (1 skipped) | no  | 0        | 6.05              |

Vitest's own `Duration` was 90.86 s, 55.61 s and 44.85 s. All 438 test files
passed in every run and no coverage threshold failure was reported.

## Observations

- No run hit an out-of-memory error, a worker crash or a test timeout. The
  per-worker heap peaked at about 260 MB, far under the 16 GB cap.
- Speedup is sub-linear: 2 to 4 workers is 1.62x, 4 to 8 workers only 1.23x.
  User and system CPU time rise with workers (about 166 s, 208 s, 276 s), so the
  extra workers mostly add contention.
- An earlier serial-vs-parallel baseline was not part of this issue's scope.

## Recommendation

Recommended default: 4 workers, resting on the 4-worker run (56.48 s, OOM = no,
no timeouts, all tests passing). The 8-worker run is faster (45.92 s) and also
shows no OOM, but CI has only 4 vCPUs, so the CI recommendation is capped at 4,
and 4 captures most of the gain on the Mac Mini too.

## Caveats

- One sample per worker count, on a shared host at load average 4 to 6 (not
  idle). Wall-clock times will vary.
- Peak process-tree RSS is not measured (see Method), so the RSS headroom
  argument rests on an upper bound.
- Nothing was run on a 4-vCPU CI runner; 4 workers there is untested.
- Changing the default in `package.json` / `vitest.config.ts` is left to the
  follow-up from #2735.
