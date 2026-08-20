#!/usr/bin/env bash
# Step 8.2B3.1 — fail-closed Supabase function deploy wrapper (local fixture tests + production guard).
# Never retries automatically. Never treats CLI exit code alone as success.
set -euo pipefail

usage() {
  echo "Usage: step82b31-deploy-wrapper.sh --slug SLUG --project-ref REF --workdir PATH [--expect-version N] [--expect-ezbr SHA] [--dry-run-output FILE]"
  exit 2
}

SLUG=""
PROJECT_REF=""
WORKDIR=""
EXPECT_VERSION=""
EXPECT_EZBR=""
PREVIOUS_VERSION=""
PREVIOUS_EZBR=""
DRY_RUN_OUTPUT=""
FIXTURE_LIVE_META=""
FIXTURE_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --project-ref) PROJECT_REF="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    --expect-version) EXPECT_VERSION="$2"; shift 2 ;;
    --expect-ezbr) EXPECT_EZBR="$2"; shift 2 ;;
    --previous-version) PREVIOUS_VERSION="$2"; shift 2 ;;
    --previous-ezbr) PREVIOUS_EZBR="$2"; shift 2 ;;
    --dry-run-output) DRY_RUN_OUTPUT="$2"; shift 2 ;;
    --fixture-live-meta) FIXTURE_LIVE_META="$2"; shift 2 ;;
    --fixture-mode) FIXTURE_MODE=true; shift ;;
    *) usage ;;
  esac
done

[[ -n "$SLUG" && -n "$PROJECT_REF" && -n "$WORKDIR" ]] || usage

REPO="$(cd "$(dirname "$0")/.." && pwd)"
AUDIT="${STEP82B31_DEPLOY_AUDIT:-$REPO/.audit-step82b31-deploy-wrapper}"
mkdir -p "$AUDIT"
LOG="$AUDIT/${SLUG}-$(date -u +%Y%m%dT%H%M%SZ).log"

fail() {
  echo "DEPLOY_WRAPPER_FAIL: $*" | tee -a "$LOG"
  exit 1
}

pass() {
  echo "DEPLOY_WRAPPER_PASS: $*" | tee -a "$LOG"
  exit 0
}

# Fixture mode: read captured CLI output instead of invoking supabase
if [[ "$FIXTURE_MODE" == true ]]; then
  [[ -f "$DRY_RUN_OUTPUT" ]] || fail "fixture output missing: $DRY_RUN_OUTPUT"
  OUT="$(cat "$DRY_RUN_OUTPUT")"
  EXIT=0
else
  START_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "START_UTC=$START_UTC" >>"$LOG"
  set +e
  OUT="$(supabase functions deploy "$SLUG" --project-ref "$PROJECT_REF" --workdir "$WORKDIR" 2>&1)"
  EXIT=$?
  set -e
  END_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "END_UTC=$END_UTC" >>"$LOG"
fi

{
  echo "exit_code=$EXIT"
  echo "--- output ---"
  echo "$OUT"
} >>"$LOG"

# Fail-closed patterns (CLI exit 0 is NOT sufficient)
if echo "$OUT" | grep -qE 'HTTP 400|"code":"UnknownError"|Failed to bundle|Module not found|failed to read file'; then
  fail "deployment API/bundle error detected in output (exit=$EXIT)"
fi

if [[ "$EXIT" -ne 0 ]]; then
  fail "non-zero CLI exit ($EXIT)"
fi

if ! echo "$OUT" | grep -q "Deployed Functions"; then
  fail "missing success marker 'Deployed Functions' in output"
fi

# Live version verification (skipped in pure fixture tests without expect-*)
if [[ -n "$EXPECT_VERSION" || -n "$EXPECT_EZBR" || -n "$PREVIOUS_VERSION" || -n "$PREVIOUS_EZBR" ]]; then
  if [[ "$FIXTURE_MODE" == true && -n "$FIXTURE_LIVE_META" ]]; then
    META="$(cat "$FIXTURE_LIVE_META")"
  else
    META="$(supabase functions list --project-ref "$PROJECT_REF" -o json 2>/dev/null)" || fail "functions list failed"
  fi
  LIVE_VERSION="$(python3 -c "import json,sys; d=json.load(sys.stdin); f=next(x for x in d if x['slug']=='$SLUG'); print(f['version'])" <<<"$META")"
  LIVE_EZBR="$(python3 -c "import json,sys; d=json.load(sys.stdin); f=next(x for x in d if x['slug']=='$SLUG'); print(f['ezbr_sha256'])" <<<"$META")"
  echo "live_version=$LIVE_VERSION live_ezbr=$LIVE_EZBR" >>"$LOG"
  if [[ -n "$PREVIOUS_VERSION" && "$LIVE_VERSION" == "$PREVIOUS_VERSION" ]]; then
    fail "live version unchanged at v$LIVE_VERSION (expected bump from v$PREVIOUS_VERSION)"
  fi
  if [[ -n "$PREVIOUS_EZBR" && "$LIVE_EZBR" == "$PREVIOUS_EZBR" ]]; then
    fail "live ezbr unchanged (expected new checksum after deploy)"
  fi
  if [[ -n "$EXPECT_VERSION" && "$LIVE_VERSION" != "$EXPECT_VERSION" ]]; then
    fail "live version $LIVE_VERSION != expected $EXPECT_VERSION"
  fi
  if [[ -n "$EXPECT_EZBR" && "$LIVE_EZBR" != "$EXPECT_EZBR" ]]; then
    fail "live ezbr mismatch"
  fi
fi

pass "slug=$SLUG verified"
