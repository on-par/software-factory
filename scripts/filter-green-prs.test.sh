#!/usr/bin/env bash
# Unit test for scripts/filter-green-prs.py: the "which PRs are landable" policy,
# exercised against fixture JSON piped on stdin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILTER="$ROOT/scripts/filter-green-prs.py"

run_filter() { python3 "$FILTER"; }

assert_eq() { # assert_eq "<label>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    printf 'FAIL: %s\nexpected: %q\nactual:   %q\n' "$1" "$2" "$3" >&2
    exit 1
  fi
}

# 1. Landable PR with one closing issue
actual="$(run_filter <<'JSON'
[{"number": 102, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": [{"number": 42}]}]
JSON
)"
expected="$(printf '102\t42')"
assert_eq "landable PR with one closing issue" "$expected" "$actual"

# 2. Standalone landable PR (no closing issues) — trailing tab must survive
actual="$(run_filter <<'JSON'
[{"number": 101, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}]
JSON
)"
expected="$(printf '101\t')"
assert_eq "standalone landable PR" "$expected" "$actual"

# 3. Draft PR => skipped
actual="$(run_filter <<'JSON'
[{"number": 200, "isDraft": true, "mergeable": "MERGEABLE", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}]
JSON
)"
assert_eq "draft PR skipped" "" "$actual"

# 4. mergeable CONFLICTING and UNKNOWN => skipped
actual="$(run_filter <<'JSON'
[
  {"number": 201, "isDraft": false, "mergeable": "CONFLICTING", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 202, "isDraft": false, "mergeable": "UNKNOWN", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}
]
JSON
)"
assert_eq "non-mergeable PRs skipped" "" "$actual"

# 5. Missing mergeable key => skipped
actual="$(run_filter <<'JSON'
[{"number": 203, "isDraft": false, "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}]
JSON
)"
assert_eq "missing mergeable key skipped" "" "$actual"

# 6. Empty statusCheckRollup [] and null => skipped
actual="$(run_filter <<'JSON'
[
  {"number": 204, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [], "closingIssuesReferences": []},
  {"number": 205, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": null, "closingIssuesReferences": []}
]
JSON
)"
assert_eq "no checks skipped" "" "$actual"

# 7. Mixed check states => skipped
actual="$(run_filter <<'JSON'
[
  {"number": 206, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}], "closingIssuesReferences": []},
  {"number": 207, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"state": "PENDING"}], "closingIssuesReferences": []}
]
JSON
)"
assert_eq "mixed check states skipped" "" "$actual"

# 8. StatusContext-style checks (state, no conclusion) => landable
actual="$(run_filter <<'JSON'
[{"number": 208, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [{"state": "SUCCESS"}], "closingIssuesReferences": []}]
JSON
)"
expected="$(printf '208\t')"
assert_eq "StatusContext-style checks landable" "$expected" "$actual"

# 9. Multi-issue PR — comma-joined, order-preserving dedup
actual="$(run_filter <<'JSON'
[{"number": 103, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": [{"number": 55}, {"number": 56}, {"number": 55}]}]
JSON
)"
expected="$(printf '103\t55,56')"
assert_eq "multi-issue PR dedup" "$expected" "$actual"

# 10. Empty stdin => empty output, exit 0
actual="$(printf '' | run_filter)"
assert_eq "empty stdin" "" "$actual"

# 11. Empty array => empty output, exit 0
actual="$(run_filter <<'JSON'
[]
JSON
)"
assert_eq "empty array" "" "$actual"

# 12. Mixed fixture — draft, conflicting, checkless, and two landable PRs, in input order
actual="$(run_filter <<'JSON'
[
  {"number": 300, "isDraft": true, "mergeable": "MERGEABLE", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 301, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": [{"number": 10}]},
  {"number": 302, "isDraft": false, "mergeable": "CONFLICTING", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []},
  {"number": 303, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [], "closingIssuesReferences": []},
  {"number": 304, "isDraft": false, "mergeable": "MERGEABLE", "statusCheckRollup": [{"conclusion": "SUCCESS"}], "closingIssuesReferences": []}
]
JSON
)"
expected="$(printf '301\t10\n304\t')"
assert_eq "mixed fixture, input order" "$expected" "$actual"

echo "PASS: filter-green-prs correctly identifies landable PRs (draft/mergeable/checks rules), joins closing issues with order-preserving dedup, and handles empty/whitespace stdin"
