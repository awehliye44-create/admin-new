#!/usr/bin/env bash
# Step 8.2B3.1 — deploy wrapper failure-detection fixture tests (no production deploy).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$REPO/.audit-step82b31-2026-08-19/deploy-wrapper-fixtures"
WRAPPER="$REPO/scripts/step82b31-deploy-wrapper.sh"
mkdir -p "$FIX"
PASS=0
FAIL=0

run_fixture() {
  local name="$1"
  local expect_rc="$2"
  local fixture="$FIX/$name.txt"
  set +e
  STEP82B31_DEPLOY_AUDIT="$FIX/audit" bash "$WRAPPER" \
    --fixture-mode \
    --slug test-fn \
    --project-ref testref \
    --workdir /tmp/unused \
    --dry-run-output "$fixture" >/dev/null 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -eq "$expect_rc" ]]; then
    echo "PASS $name (rc=$rc)"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name expected rc=$expect_rc got rc=$rc"
    FAIL=$((FAIL + 1))
  fi
}

cat >"$FIX/exit0-http400.txt" <<'EOF'
WARNING: Docker is not running
Uploading asset (test-fn): supabase/functions/test-fn/index.ts
{"_tag":"Error","error":{"code":"UnknownError","message":"unexpected deploy status 400: {\"message\":\"Failed to bundle the function (reason: Module not found \\\"paymentSessionFinancialLockSSOT.ts\\\").\"}"}}
EOF

cat >"$FIX/exit0-module-not-found.txt" <<'EOF'
Uploading asset (test-fn): supabase/functions/test-fn/index.ts
Failed to bundle the function (reason: Module not found)
EOF

cat >"$FIX/exit-nonzero.txt" <<'EOF'
Error: something went wrong
EOF

cat >"$FIX/exit0-success-no-version-check.txt" <<'EOF'
Uploading asset (test-fn): supabase/functions/test-fn/index.ts
{"project_ref":"testref","functions":["test-fn"],"message":"Deployed Functions."}
EOF

run_fixture exit0-http400 1
run_fixture exit0-module-not-found 1
run_fixture exit-nonzero 1
run_fixture exit0-success-no-version-check 0

cat >"$FIX/live-meta-unchanged.json" <<'EOF'
[{"slug":"test-fn","version":227,"ezbr_sha256":"abc","status":"ACTIVE"}]
EOF

set +e
STEP82B31_DEPLOY_AUDIT="$FIX/audit" bash "$WRAPPER" \
  --fixture-mode \
  --slug test-fn \
  --project-ref testref \
  --workdir /tmp/unused \
  --dry-run-output "$FIX/exit0-success-no-version-check.txt" \
  --expect-version 228 \
  --fixture-live-meta "$FIX/live-meta-unchanged.json" >/dev/null 2>&1
rc=$?
set -e
if [[ "$rc" -eq 1 ]]; then echo "PASS exit0-success-version-unchanged (rc=1)"; PASS=$((PASS + 1)); else echo "FAIL exit0-success-version-unchanged expected rc=1 got rc=$rc"; FAIL=$((FAIL + 1)); fi

cat >"$FIX/live-meta-changed.json" <<'EOF'
[{"slug":"test-fn","version":228,"ezbr_sha256":"def","status":"ACTIVE"}]
EOF

set +e
STEP82B31_DEPLOY_AUDIT="$FIX/audit" bash "$WRAPPER" \
  --fixture-mode \
  --slug test-fn \
  --project-ref testref \
  --workdir /tmp/unused \
  --dry-run-output "$FIX/exit0-success-no-version-check.txt" \
  --expect-version 228 \
  --fixture-live-meta "$FIX/live-meta-changed.json" >/dev/null 2>&1
rc=$?
set -e
if [[ "$rc" -eq 0 ]]; then echo "PASS exit0-success-version-changed (rc=0)"; PASS=$((PASS + 1)); else echo "FAIL exit0-success-version-changed expected rc=0 got rc=$rc"; FAIL=$((FAIL + 1)); fi

echo "deploy_wrapper_tests: pass=$PASS fail=$FAIL"
[[ "$FAIL" -eq 0 ]]
