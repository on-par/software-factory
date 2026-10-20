#!/usr/bin/env bash
# Fixture tests for the PR selection policy used by the sweep.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILTER="$ROOT/scripts/filter-green-prs.py"
ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

run_filter() { python3 "$FILTER" 2>"$ERR_FILE"; }
assert_eq() {
  if [ "$2" != "$3" ]; then
    printf 'FAIL: %s\nexpected: %q\nactual:   %q\n' "$1" "$2" "$3" >&2
    exit 1
  fi
}
assert_err() {
  grep -qF "$1" "$ERR_FILE" || { echo "FAIL: missing diagnostic: $1" >&2; cat "$ERR_FILE" >&2; exit 1; }
}

# One eligible factory PR keeps the three-column TSV contract.
actual="$(run_filter <<'JSON'
[{"number":102,"headRefName":"factory/42-x","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":42}]}]
JSON
)"
assert_eq "landable PR with one closing issue" "$(printf '102\t42\t')" "$actual"

# non-factory branch is not landable (PR #2580 shape)
actual="$(run_filter <<'JSON'
[{"number":2580,"headRefName":"feat/2245-prerelease-on-merge","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"}],"closingIssuesReferences":[]}]
JSON
)"
assert_eq "non-factory branch is not landable (PR #2580 shape)" "" "$actual"
assert_err "SKIPPING PR #2580: not a factory branch"

# Branch rejection happens before issue count, while factory branches explain issue count.
actual="$(run_filter <<'JSON'
[
 {"number":1,"headRefName":"feat/human","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":42}]},
 {"number":2,"headRefName":"factory/standalone","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[]},
 {"number":3,"headRefName":"factory/multi","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":55},{"number":56},{"number":55}]},
 {"number":4,"headRefName":"factory/42-x","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":42},{"number":42}]}
]
JSON
)"
assert_eq "rejections disappear and duplicate issue refs deduplicate" "$(printf '4\t42\t')" "$actual"
assert_err "SKIPPING PR #1: not a factory branch"
assert_err "SKIPPING PR #2: closes no issue"
assert_err "SKIPPING PR #3: closes multiple issues (#55, #56)"

actual="$(run_filter <<'JSON'
[{"number":17,"headRefName":"factory/17","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":"invalid"}]}]
JSON
)"
assert_eq "malformed closing issue references are rejected" "" "$actual"
assert_err "SKIPPING PR #17: invalid closing issue references"

# Literal custom prefixes, empty/unset fallback, and invalid heads.
actual="$(BRANCH_PREFIX='release[*] ' run_filter <<'JSON'
[{"number":5,"headRefName":"release[*] candidate","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":8}]}]
JSON
)"
assert_eq "custom prefix is literal" "$(printf '5\t8\t')" "$actual"
for prefix_case in unset empty; do
  if [ "$prefix_case" = unset ]; then
    actual="$( (unset BRANCH_PREFIX; run_filter) <<'JSON'
[{"number":6,"headRefName":"factory/6","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":6}]}]
JSON
)"
  else
    actual="$(BRANCH_PREFIX='' run_filter <<'JSON'
[{"number":6,"headRefName":"factory/6","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":6}]}]
JSON
)"
  fi
  assert_eq "$prefix_case prefix defaults to factory/" "$(printf '6\t6\t')" "$actual"
done
actual="$(run_filter <<'JSON'
[{"number":7,"headRefName":null,"isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":7}]},{"number":8,"headRefName":42,"isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":8}]},{"number":9,"isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":9}]}]
JSON
)"
assert_eq "missing, null and non-string heads are rejected" "" "$actual"
assert_err "SKIPPING PR #7: not a factory branch"
assert_err "SKIPPING PR #8: not a factory branch"
assert_err "SKIPPING PR #9: not a factory branch"

# Readiness rules remain strict, and each rejection has an explanation.
actual="$(run_filter <<'JSON'
[
 {"number":10,"headRefName":"factory/10","isDraft":true,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":10}]},
 {"number":11,"headRefName":"factory/11","isDraft":false,"mergeable":"UNKNOWN","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":11}]},
 {"number":12,"headRefName":"factory/12","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[],"closingIssuesReferences":[{"number":12}]},
 {"number":13,"headRefName":"factory/13","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"},{"state":"PENDING"}],"closingIssuesReferences":[{"number":13}]},
 {"number":14,"headRefName":"factory/14","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"state":"SUCCESS"}],"closingIssuesReferences":[{"number":14}],"labels":[{"name":"no-auto-merge"}]},
 {"number":15,"headRefName":"factory/15","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":15}],"labels":[{"name":"bug"}]}
]
JSON
)"
assert_eq "readiness and labels retain selected rows" "$(printf '14\t14\tgated\n15\t15\t')" "$actual"
assert_err "SKIPPING PR #10: draft PR"
assert_err "SKIPPING PR #11: mergeable state is UNKNOWN"
assert_err "SKIPPING PR #12: no status checks"
assert_err "SKIPPING PR #13: checks are not all SUCCESS"

actual="$(GATE_LABEL=hold run_filter <<'JSON'
[{"number":16,"headRefName":"factory/16","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}],"closingIssuesReferences":[{"number":16}],"labels":[{"name":"hold"}]}]
JSON
)"
assert_eq "GATE_LABEL override" "$(printf '16\t16\tgated')" "$actual"

assert_eq "empty stdin" "" "$(printf '' | run_filter)"
assert_eq "empty array" "" "$(run_filter <<'JSON'
[]
JSON
)"
echo "PASS: filter-green-prs branch, readiness, issue-count and gate policies"
