#!/usr/bin/env bash
# Bug #37 release gate — refuse to report payment Edge fixes as shipped when
# required functions are missing, auth is unavailable, markers drift, OR the
# downloaded live tree content-hash does not match the local committed source.
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-thazislrdkjpvvghtvzo}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REQUIRED_FUNCTIONS=(
  "submit-revolut-google-pay"
  "revolut-webhook"
)

# Exact fingerprint from googlePayDeployFingerprint.ts — bump when contract changes.
EXPECTED_FINGERPRINT="BUG37_GPAY_EDGE_FINGERPRINT_v6_immutable_attempt_contract"

LIVE_MUST_CONTAIN=(
  "resolveGooglePayBillingContract"
  "GOOGLE_PAY_BILLING"
  "isFabricatedGooglePayPostcode"
  "$EXPECTED_FINGERPRINT"
  "mayFinaliseAuthorisedPaymentSession"
)
LIVE_MUST_NOT_CONTAIN=(
  '|| "000000"'
)

resolve_access_token() {
  if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
    return 0
  fi
  if [[ -f "${HOME}/.supabase/access-token" ]]; then
    local file_tok
    file_tok="$(tr -d '[:space:]' <"${HOME}/.supabase/access-token" 2>/dev/null || true)"
    if [[ -n "$file_tok" ]]; then
      export SUPABASE_ACCESS_TOKEN="$file_tok"
      echo "DEPLOY_GATE_AUTH: using ~/.supabase/access-token"
      return 0
    fi
  fi
  return 1
}

# Content hash of production TS (exclude *.test.ts). Detects real drift, not markers alone.
hash_fn_tree() {
  local root="$1"
  (
    cd "$root"
    find . -type f -name '*.ts' ! -name '*.test.ts' -print \
      | LC_ALL=C sort \
      | while IFS= read -r f; do
          # Normalise path prefix noise from download layouts.
          shasum -a 256 "$f"
        done \
      | shasum -a 256 \
      | awk '{print $1}'
  )
}

if ! resolve_access_token; then
  echo "DEPLOY_GATE_BLOCKED: SUPABASE_ACCESS_TOKEN is not set."
  echo "Create a token at https://supabase.com/dashboard/account/tokens"
  echo "then: export SUPABASE_ACCESS_TOKEN='sbp_…'"
  echo "and re-run: $0"
  echo "Bug #37 must NOT be reported as shipped while this gate is blocked."
  exit 2
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "DEPLOY_GATE_BLOCKED: supabase CLI not found on PATH"
  exit 2
fi

LOCAL_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "LOCAL_SOURCE_COMMIT: $LOCAL_SHA"

LIST_OUT="$(supabase functions list --project-ref "$PROJECT_REF" 2>&1 || true)"
if [[ -z "$LIST_OUT" || "$LIST_OUT" == *"Access token"* || "$LIST_OUT" == *"Error"* || "$LIST_OUT" == *"Unauthorized"* ]]; then
  echo "DEPLOY_GATE_BLOCKED: could not list functions for $PROJECT_REF"
  echo "$LIST_OUT" | head -5
  echo "Bug #37 must NOT be reported as shipped while this gate is blocked."
  exit 2
fi

missing=0
for fn in "${REQUIRED_FUNCTIONS[@]}"; do
  if ! printf '%s' "$LIST_OUT" | rg -q "$fn"; then
    echo "MISSING_LIVE_FUNCTION: $fn"
    missing=1
  else
    echo "PRESENT: $fn"
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo "DEPLOY_GATE_FAILED: critical payment function(s) not live on $PROJECT_REF"
  exit 1
fi

TMPDIR_GATE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_GATE"' EXIT

download_fn() {
  local slug="$1"
  mkdir -p "$TMPDIR_GATE/$slug"
  (
    cd "$TMPDIR_GATE/$slug"
    supabase functions download "$slug" --project-ref "$PROJECT_REF" \
      >"$TMPDIR_GATE/${slug}.dl.out" 2>"$TMPDIR_GATE/${slug}.dl.err"
  )
}

echo "DOWNLOADING live submit-revolut-google-pay + revolut-webhook for drift check…"
if ! download_fn submit-revolut-google-pay; then
  echo "DEPLOY_GATE_BLOCKED: could not download live submit-revolut-google-pay"
  head -20 "$TMPDIR_GATE/submit-revolut-google-pay.dl.err" || true
  exit 2
fi
if ! download_fn revolut-webhook; then
  echo "DEPLOY_GATE_BLOCKED: could not download live revolut-webhook"
  head -20 "$TMPDIR_GATE/revolut-webhook.dl.err" || true
  exit 2
fi

# Prefer the nested supabase/functions/<slug> tree (not the outer download cwd).
LIVE_SUBMIT_ROOT="$(find "$TMPDIR_GATE/submit-revolut-google-pay" -type f -path '*/supabase/functions/submit-revolut-google-pay/index.ts' -print \
  | head -1 | xargs -I{} dirname {})"
LIVE_WEBHOOK_ROOT="$(find "$TMPDIR_GATE/revolut-webhook" -type f -path '*/supabase/functions/revolut-webhook/index.ts' -print \
  | head -1 | xargs -I{} dirname {})"
if [[ -z "$LIVE_SUBMIT_ROOT" || -z "$LIVE_WEBHOOK_ROOT" || ! -f "$LIVE_SUBMIT_ROOT/index.ts" ]]; then
  echo "DEPLOY_GATE_BLOCKED: downloaded trees missing expected folders"
  find "$TMPDIR_GATE" -maxdepth 6 -type d | head -40
  exit 2
fi
echo "LIVE_SUBMIT_ROOT: $LIVE_SUBMIT_ROOT"
echo "LIVE_WEBHOOK_ROOT: $LIVE_WEBHOOK_ROOT"

# Search files directly — do not concatenate multi-MB webhook trees into a
# shell variable (truncation caused false marker misses).
mismatch=0
for needle in "${LIVE_MUST_CONTAIN[@]}"; do
  if ! rg -F -q -- "$needle" "$LIVE_SUBMIT_ROOT" "$LIVE_WEBHOOK_ROOT" 2>/dev/null; then
    echo "LIVE_VERSION_MISMATCH: missing marker '$needle'"
    mismatch=1
  else
    echo "LIVE_MARKER_OK: $needle"
  fi
done
for forbidden in "${LIVE_MUST_NOT_CONTAIN[@]}"; do
  if rg -F -q -- "$forbidden" "$LIVE_SUBMIT_ROOT" "$LIVE_WEBHOOK_ROOT" 2>/dev/null; then
    echo "LIVE_VERSION_MISMATCH: forbidden marker '$forbidden' still present"
    mismatch=1
  else
    echo "LIVE_FORBIDDEN_ABSENT: $forbidden"
  fi
done

# Content-hash: local submit function vs live (production .ts only).
LOCAL_SUBMIT="$REPO_ROOT/supabase/functions/submit-revolut-google-pay"
LOCAL_HASH="$(hash_fn_tree "$LOCAL_SUBMIT")"
LIVE_HASH="$(hash_fn_tree "$LIVE_SUBMIT_ROOT")"
echo "LOCAL_SUBMIT_HASH: $LOCAL_HASH"
echo "LIVE_SUBMIT_HASH:  $LIVE_HASH"
if [[ "$LOCAL_HASH" != "$LIVE_HASH" ]]; then
  echo "LIVE_VERSION_MISMATCH: submit-revolut-google-pay content hash differs from local $LOCAL_SHA"
  echo "Diff hint (file list):"
  (cd "$LOCAL_SUBMIT" && find . -name '*.ts' ! -name '*.test.ts' | LC_ALL=C sort) >"$TMPDIR_GATE/local.files"
  (cd "$LIVE_SUBMIT_ROOT" && find . -name '*.ts' ! -name '*.test.ts' | LC_ALL=C sort) >"$TMPDIR_GATE/live.files"
  diff -u "$TMPDIR_GATE/local.files" "$TMPDIR_GATE/live.files" || true
  mismatch=1
else
  echo "LIVE_CONTENT_HASH_OK: submit-revolut-google-pay matches local source"
fi

# Webhook late-finalise helper must match local mayFinalise source.
LOCAL_MAY="$REPO_ROOT/supabase/functions/revolut-webhook/lib/mayFinaliseAuthorisedPaymentSession.ts"
LIVE_MAY="$(find "$LIVE_WEBHOOK_ROOT" -name 'mayFinaliseAuthorisedPaymentSession.ts' | head -1)"
if [[ ! -f "$LIVE_MAY" ]]; then
  echo "LIVE_VERSION_MISMATCH: mayFinaliseAuthorisedPaymentSession.ts missing from live webhook"
  mismatch=1
elif ! cmp -s "$LOCAL_MAY" "$LIVE_MAY"; then
  echo "LIVE_VERSION_MISMATCH: mayFinaliseAuthorisedPaymentSession.ts differs from local"
  mismatch=1
else
  echo "LIVE_CONTENT_OK: mayFinaliseAuthorisedPaymentSession.ts"
fi

if [[ "$mismatch" -ne 0 ]]; then
  echo "DEPLOY_GATE_FAILED: live Edge does not match local Bug #37 source ($LOCAL_SHA)"
  echo "Redeploy from the clean commit, then re-run this gate. Do NOT mark Bug #37 fixed."
  exit 1
fi

echo "DEPLOY_GATE_OK: critical payment functions present, fingerprint+content match local $LOCAL_SHA on $PROJECT_REF"
echo "EXPECTED_FINGERPRINT: $EXPECTED_FINGERPRINT"
