#!/usr/bin/env bash
# Runtime lock: Step 8.2A.5 shell scripts must remain bash 3.2 compatible.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

operational=(
  "$REPO/scripts/step82a5-download-function-archive.sh"
  "$REPO/scripts/step82a5-download-helpers.sh"
  "$REPO/scripts/step82a5-secure-download-with-token.sh"
  "$REPO/scripts/step82a5-download-fixture.test.sh"
  "$REPO/scripts/step82a5-downloader-resilience.test.sh"
)

violations=0
report_violation() {
  echo "VIOLATION: $1"
  violations=$((violations + 1))
}

for script in "${operational[@]}"; do
  [[ -f "$script" ]] || fail "missing script: $script"
  base="$(basename "$script")"
  if grep -q 'declare -A' "$script" 2>/dev/null; then
    report_violation "$base contains declare -A"
  fi
  if grep -qE '(^|[^a-zA-Z_])(mapfile|readarray)([^a-zA-Z_]|$)' "$script" 2>/dev/null; then
    report_violation "$base contains mapfile/readarray"
  fi
  if grep -q 'local -n' "$script" 2>/dev/null; then
    report_violation "$base contains local -n (nameref)"
  fi
  if grep -qE '\$\{[A-Za-z0-9_]+,,' "$script" 2>/dev/null; then
    report_violation "$base contains lowercase parameter expansion"
  fi
done

[[ "$violations" -eq 0 ]] || fail "$violations bash 4-only construct(s) remain"
pass "no bash 4-only constructs in step82a5 downloader shell scripts"
