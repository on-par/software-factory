# Checkers Guide

## Built-in Checkers

All built-in checkers live in `lib/checkers/` and return JSON:

```json
{
  "checker": "<name>",
  "result": "PASS" | "FAIL",
  "details": "<specific findings>"
}
```

### compile
Runs the project's build command (npm run build, make, cargo build, go build — auto-detected). Fails if the build errors.

### tests
Runs the test suite (scripts/verify.sh, npm test, make test — auto-detected). Fails if any test fails.

### lint
Runs linting and type checking (ESLint, TypeScript tsc --noEmit, Stylelint). Fails on any error.

### links
Scans HTML files for all href/src URLs. Verifies internal links resolve to real files and external links return HTTP 200. Fails on any broken link.

### accessibility
Checks WCAG 2.2 AA criteria in HTML files: alt text on images, labels on inputs, heading hierarchy (no skipping levels), placeholder links (href="#"). Uses axe-core if available, falls back to basic HTML checks.

## Custom Checkers

### Agent-based (no code)

Add a `custom_*` checker to your constitution's frontmatter:

```yaml
checkers:
  - custom_brand_voice
```

The checker agent reads the constitution's standards section and verifies the worktree against it. No code needed — the constitution IS the prompt.

Best for: brand voice, tone, design fit, SEO quality, content completeness.

### Code-based (fast, no model cost)

Add a bash function to `lib/checkers/custom.sh`:

```bash
check_custom_my_check() {
  local wt="$1" spec="$2" constitution_body="$3"
  cd "$wt" || return 1
  
  local result="PASS" details=""
  
  # Your verification logic here
  if ! grep -q "expected-string" some-file.txt 2>/dev/null; then
    result="FAIL"
    details="expected-string not found in some-file.txt"
  fi
  
  jq -n --arg r "$result" --arg d "$details" \
    '{checker: "custom_my_check", result: $r, details: $d}'
}
```

Best for: file existence, JSON validity, value matching, regex checks.

## Writing a New Built-in Checker

1. Create `lib/checkers/<name>.sh` with a function `check_<name>()`
2. The function takes 3 args: `<worktree> <spec_file> <constitution_body>`
3. Returns JSON on stdout
4. Source it automatically (all `lib/checkers/*.sh` are sourced)

## Checker Execution Order

Checkers run in this order:
1. Standard checkers (compile, tests, lint) — always
2. Constitution checkers (from frontmatter) — in listed order
3. Custom checkers (custom_*) — via agent or code-based function

All checkers run independently. A failure in one doesn't stop the others. The factory collects all results and reports them together.

## Rework Loop

When any checker fails:
1. All failures are collected with specific feedback
2. The worker gets a rework prompt with all failures listed
3. Worker fixes and commits
4. Checkers re-run
5. Max 3 rounds; after that, the issue is parked for human review

## Dispute Process

If the worker believes a checker is wrong:
1. Worker prints `ESCALATE:<question>` and stops
2. The boss (expensive model) re-reads the constitution
3. Boss decides: `upheld` (worker must fix) or `overruled` (checker was wrong)
4. If overruled, the check passes and work continues
5. If upheld, the worker must fix or the issue is parked