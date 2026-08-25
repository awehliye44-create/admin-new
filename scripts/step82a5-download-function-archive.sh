#!/usr/bin/env bash
# Step 8.2A.5 — Safe deployed function archive acquisition + workdir reconstruction.
# READ-ONLY against production. No deploy, no migration apply.
# Compatible with macOS /bin/bash 3.2+.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/step82a5-download-helpers.sh
source "$REPO/scripts/step82a5-download-helpers.sh"
OUT_ROOT="$REPO/.rollback-step82a5-2026-08-19"
AUDIT="$REPO/.audit-step82a5-2026-08-19"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/step82a5-download-XXXXXX")"
mkdir -p "$OUT_ROOT" "$AUDIT/archives" "$AUDIT/extract" "$TMP_ROOT"

ACQUIRED_TSV="$AUDIT/download-acquired.tsv"
RECON_TSV="$AUDIT/download-recon.tsv"
rm -f "$ACQUIRED_TSV" "$RECON_TSV"

PROJECT_REF="${SUPABASE_PROJECT_REF:-thazislrdkjpvvghtvzo}"
SB_BIN="${SUPABASE_CLI_BIN:-/opt/homebrew/Cellar/supabase/2.109.0/libexec/lib/node_modules/supabase/node_modules/@supabase/cli-darwin-arm64/bin/supabase}"
PATCHED_CLI="${STEP82A5_PATCHED_CLI:-/tmp/supabase-cli-allow-shared}"

TARGETS=(
  "finalize-trip-and-capture|447|4ac5fac294eaf3ca3a9e77ffdce541eccf25454d18b8e9d4fd271a8343f3a19d"
  "sweep-revolut-stale-holds|87|815d94b4e18b56dcef3817ebcbaa1f4e964428cd30cdf753b987fb6fc1e2470d"
)

log() { echo "[step82a5-download] $*" | tee -a "$AUDIT/download.log"; }

cleanup() {
  rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

# ── 0. Authentication (report PASS/FAIL only; never log token) ───────────────
auth_report() {
  if supabase projects list >/dev/null 2>&1; then
    echo "PASS" > "$AUDIT/auth-cli-projects-list.flag"
    log "auth supabase projects list PASS"
  else
    echo "FAIL" > "$AUDIT/auth-cli-projects-list.flag"
    log "auth supabase projects list FAIL"
    exit 1
  fi
  if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
    echo "SET" > "$AUDIT/auth-env-token.flag"
    log "auth SUPABASE_ACCESS_TOKEN env SET (value not logged)"
  else
    echo "UNSET" > "$AUDIT/auth-env-token.flag"
    log "auth SUPABASE_ACCESS_TOKEN env UNSET"
  fi
}
auth_report

fetch_meta() {
  local slug="$1"
  "$SB_BIN" functions list --project-ref "$PROJECT_REF" -o json \
    | python3 -c "import json,sys; d=json.load(sys.stdin); f=next(x for x in d if x['slug']=='$slug'); print(json.dumps(f, indent=2))"
}

verify_meta() {
  local slug="$1" expect_version="$2" expect_ezbr="$3"
  local live_version live_ezbr
  live_version="$(python3 -c "import json; d=json.load(open('$AUDIT/${slug}-meta.json')); print(d['version'])")"
  live_ezbr="$(python3 -c "import json; d=json.load(open('$AUDIT/${slug}-meta.json')); print(d['ezbr_sha256'])")"
  if [[ "$live_version" != "$expect_version" || "$live_ezbr" != "$expect_ezbr" ]]; then
    log "FAIL metadata slug=$slug live v$live_version ezbr=$live_ezbr expected v$expect_version ezbr=$expect_ezbr"
    return 1
  fi
  log "metadata OK slug=$slug v$live_version ezbr=$live_ezbr"
}

download_function_archive() {
  local slug="$1"
  local raw_out="$AUDIT/archives/${slug}-body.bin"
  local headers_out="$AUDIT/archives/${slug}-response.headers"
  local meta_out="$AUDIT/archives/${slug}-response.meta.json"
  local token="${SUPABASE_ACCESS_TOKEN:-}"
  local hdr_file="$TMP_ROOT/curl-auth-${slug}.conf"

  if step82a5_archive_is_preserved "$raw_out"; then
    log "archive PRESERVED slug=$slug path=$raw_out sha256=$(cat "$raw_out.sha256") (skip re-download)"
    return 0
  fi

  if [[ -z "$token" ]]; then
    for candidate in \
      "$HOME/.supabase/access-token" \
      "$HOME/.config/supabase/access-token" \
      "$REPO/.supabase/access-token"; do
      if [[ -f "$candidate" ]]; then
        token="$(tr -d '[:space:]' < "$candidate")"
        break
      fi
    done
  fi

  if [[ -z "$token" ]]; then
    log "archive SKIP $slug — no SUPABASE_ACCESS_TOKEN"
    echo "SKIPPED_NO_TOKEN" > "$raw_out.status"
    return 1
  fi

  umask 077
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$hdr_file"
  chmod 600 "$hdr_file"

  local url="https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/${slug}/body"
  log "GET function body (token via curl config; response headers saved separately)"
  local http_code
  http_code="$(curl -sS \
    --config "$hdr_file" \
    -H "Accept: multipart/form-data, application/zip, application/gzip, application/octet-stream, application/json" \
    -D "$headers_out" \
    -o "$raw_out" \
    -w '%{http_code}' \
    "$url")"
  rm -f "$hdr_file"

  local content_type content_length
  content_type="$(python3 - <<PY
from pathlib import Path
for line in Path("$headers_out").read_text().splitlines():
    if line.lower().startswith('content-type:'):
        print(line.split(':',1)[1].strip())
        break
PY
)"
  content_length="$(wc -c < "$raw_out" | tr -d ' ')"
  python3 - <<PY > "$meta_out"
import json
print(json.dumps({
  "http_status": int("$http_code"),
  "content_type": """$content_type""",
  "content_length": int("$content_length"),
  "headers_file": "$headers_out",
  "body_file": "$raw_out",
}, indent=2))
PY

  if step82a5_http_response_is_error "$http_code"; then
    log "FAIL HTTP $http_code for $slug"
    echo "HTTP_${http_code}" > "$raw_out.status"
    return 1
  fi

  shasum -a 256 "$raw_out" | awk '{print $2}' > "$raw_out.sha256"
  echo "OK" > "$raw_out.status"
  cp "$raw_out" "$AUDIT/archives/${slug}-body.evidence.bin"
  cp "$headers_out" "$AUDIT/archives/${slug}-response.evidence.headers"
  shasum -a 256 "$AUDIT/archives/${slug}-body.evidence.bin" | awk '{print $2}' \
    > "$AUDIT/archives/${slug}-body.evidence.bin.sha256"
  log "archive saved slug=$slug bytes=$content_length content_type=${content_type:-unknown}"
}

safe_extract_archive() {
  local slug="$1"
  local raw="$AUDIT/archives/${slug}-body.bin"
  local headers="$AUDIT/archives/${slug}-response.headers"
  local extract_dir="$TMP_ROOT/extract-${slug}"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"
  log "safe extract slug=$slug -> $extract_dir"

  deno run --allow-read --allow-write --allow-run "$REPO/scripts/step82a5-safe-archive-extract.ts" \
    --archive "$raw" \
    --response-headers "$headers" \
    --out "$extract_dir" \
    --slug "$slug" \
    --inspect-only \
    2>&1 | tee "$AUDIT/extract/${slug}-inspect.log"

  deno run --allow-read --allow-write --allow-run "$REPO/scripts/step82a5-safe-archive-extract.ts" \
    --archive "$raw" \
    --response-headers "$headers" \
    --out "$extract_dir" \
    --slug "$slug" \
    2>&1 | tee "$AUDIT/extract/${slug}.log"

  printf '%s\n' "$extract_dir" > "$AUDIT/extract/${slug}.path"
}

reconstruct_workdir() {
  local slug="$1" version="$2" ezbr="$3" extract_dir="$4"
  local raw="$AUDIT/archives/${slug}-body.bin"
  local out_dir="$OUT_ROOT/${slug}-v${version}-workdir"
  rm -rf "$out_dir"
  set +e
  deno run --allow-read --allow-write --allow-run --allow-env "$REPO/scripts/step82a5-reconstruct-workdir.ts" \
    --slug "$slug" --version "$version" --ezbr "$ezbr" \
    --extract-dir "$extract_dir" \
    --out-dir "$out_dir" \
    --archive "$raw" \
    2>&1 | tee "$AUDIT/reconstruct-${slug}.log"
  local rc=$?
  set -e
  return $rc
}

# Phase A — verify metadata + download all archives (preserve existing raw bins)
for spec in "${TARGETS[@]}"; do
  IFS='|' read -r slug version ezbr <<< "$spec"
  log "=== metadata $slug v$version ==="
  fetch_meta "$slug" > "$AUDIT/${slug}-meta.json"
  if ! verify_meta "$slug" "$version" "$ezbr"; then
    step82a5_status_set "$RECON_TSV" "$slug" false
    continue
  fi
  if download_function_archive "$slug"; then
    step82a5_status_set "$ACQUIRED_TSV" "$slug" true
  else
    step82a5_status_set "$ACQUIRED_TSV" "$slug" false
  fi
done

# Phase B — extract + reconstruct per target; continue on failure
FINAL_RC=0
for spec in "${TARGETS[@]}"; do
  IFS='|' read -r slug version ezbr <<< "$spec"
  log "=== reconstruct $slug v$version ==="
  if [[ "$(step82a5_status_get "$ACQUIRED_TSV" "$slug" false)" != "true" ]]; then
    log "SKIP reconstruct $slug — archive not acquired"
    step82a5_status_set "$RECON_TSV" "$slug" false
    FINAL_RC=1
    continue
  fi
  safe_extract_archive "$slug"
  extract_dir="$(cat "$AUDIT/extract/${slug}.path")"
  if reconstruct_workdir "$slug" "$version" "$ezbr" "$extract_dir"; then
    step82a5_status_set "$RECON_TSV" "$slug" true
    log "ROLLBACK READY slug=$slug v$version"
  else
    step82a5_status_set "$RECON_TSV" "$slug" false
    log "ROLLBACK NOT READY slug=$slug v$version (see $AUDIT/reconstruct-${slug}.log)"
    FINAL_RC=1
  fi
done

step82a5_write_download_summary "$AUDIT" \
  "$(step82a5_status_get "$ACQUIRED_TSV" "finalize-trip-and-capture" false)" \
  "$(step82a5_status_get "$RECON_TSV" "finalize-trip-and-capture" false)" \
  "$(step82a5_status_get "$ACQUIRED_TSV" "sweep-revolut-stale-holds" false)" \
  "$(step82a5_status_get "$RECON_TSV" "sweep-revolut-stale-holds" false)"

log "download phase complete rc=$FINAL_RC"
exit $FINAL_RC
