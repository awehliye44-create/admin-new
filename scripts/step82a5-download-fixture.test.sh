#!/usr/bin/env bash
# No-network fixture test for Step 8.2A.5 downloader (bash 3.2+ compatible).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/step82a5-download-helpers.sh
source "$REPO/scripts/step82a5-download-helpers.sh"
FIX="$REPO/scripts/fixtures/step82a5"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

tmp="$(mktemp -d)"
fixture_audit=""
mock_bin=""
trap 'rm -rf "$tmp" ${fixture_audit:+"$fixture_audit"} ${mock_bin:+"$mock_bin"}' EXIT

# ── 1. preserve + HTTP status + TSV status + summary JSON ────────────────────
archive="$tmp/body.bin"
sha="$tmp/body.bin.sha256"
status="$tmp/body.bin.status"
printf 'fixture-bytes' > "$archive"
echo "abc123" > "$sha"

step82a5_archive_is_preserved "$archive" && fail "preserve should fail without status sidecar"
echo "OK" > "$status"
step82a5_archive_is_preserved "$archive" || fail "preserve should pass with body+sha256+OK"
echo "HTTP_401" > "$status"
step82a5_archive_is_preserved "$archive" && fail "preserve should fail when status != OK"
echo "OK" > "$status"

step82a5_http_response_is_error 199 || fail "199 should be error"
step82a5_http_response_is_error 200 && fail "200 should succeed"
step82a5_http_response_is_error 299 && fail "299 should succeed"
step82a5_http_response_is_error 300 || fail "300 should be error (use -ge not >= in [[ ]])"
step82a5_http_response_is_error 404 || fail "404 should be error"

status_tsv="$tmp/status.tsv"
step82a5_status_set "$status_tsv" "finalize-trip-and-capture" true
step82a5_status_set "$status_tsv" "sweep-revolut-stale-holds" false
[[ "$(step82a5_status_get "$status_tsv" "finalize-trip-and-capture" false)" == "true" ]] || fail "TSV hyphen slug read"
[[ "$(step82a5_status_get "$status_tsv" "sweep-revolut-stale-holds" false)" == "false" ]] || fail "TSV hyphen slug false"
[[ "$(step82a5_status_get "$status_tsv" "missing-slug" true)" == "true" ]] || fail "TSV fallback"
step82a5_status_set "$status_tsv" "finalize-trip-and-capture" false
[[ "$(step82a5_status_get "$status_tsv" "finalize-trip-and-capture" true)" == "false" ]] || fail "TSV update"

fixture_audit="$(mktemp -d)"
step82a5_write_download_summary "$fixture_audit" true true false false
python3 - <<PY || fail "download-summary.json invalid"
import json
from pathlib import Path
d=json.loads(Path("$fixture_audit/download-summary.json").read_text())
assert d["finalize-trip-and-capture"]["archive"] is True
assert d["sweep-revolut-stale-holds"]["rollback_ready"] is False
PY
pass "preserve, http status (-ge), TSV status, summary JSON"

# ── 2. Simulated flow (no network) ───────────────────────────────────────────
fixture_audit="$(mktemp -d)"
mkdir -p "$fixture_audit/archives"
FIXTURE_V447="$FIX/multipart-body.bin"
FIXTURE_HEADERS="$FIX/multipart-response.headers"

v447_raw="$fixture_audit/archives/finalize-trip-and-capture-body.bin"
cp "$FIXTURE_V447" "$v447_raw"
shasum -a 256 "$v447_raw" | awk '{print $2}' > "${v447_raw}.sha256"
echo "OK" > "${v447_raw}.status"
step82a5_archive_is_preserved "$v447_raw" || fail "v447 preserved skip branch"

sweep_raw="$fixture_audit/archives/sweep-revolut-stale-holds-body.bin"
step82a5_archive_is_preserved "$sweep_raw" && fail "sweep should not be preserved initially"

mock_bin="$(mktemp -d)"
cat > "$mock_bin/curl" <<'MOCK'
#!/usr/bin/env bash
out=""
headers=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    -o) i=$((i + 1)); out="${args[$i]}" ;;
    -D) i=$((i + 1)); headers="${args[$i]}" ;;
  esac
  i=$((i + 1))
done
if [[ "$out" == *sweep-revolut-stale-holds-body.bin ]]; then
  cp "${STEP82A5_FIXTURE_SWEEP_SRC:?}" "$out"
  printf 'HTTP/1.1 200 OK\r\n\r\n' > "$headers"
  printf '200'
else
  printf '404'
fi
MOCK
chmod +x "$mock_bin/curl"
export STEP82A5_FIXTURE_SWEEP_SRC="$FIXTURE_V447"
export PATH="$mock_bin:$PATH"

http_code="$(curl -sS -o "$sweep_raw" -D "${sweep_raw}.headers" -w '%{http_code}' "https://example.invalid/sweep")"
step82a5_http_response_is_error "$http_code" && fail "mock sweep download should be HTTP 200"
shasum -a 256 "$sweep_raw" | awk '{print $2}' > "${sweep_raw}.sha256"
echo "OK" > "${sweep_raw}.status"
step82a5_archive_is_preserved "$sweep_raw" || fail "sweep sidecar after mock download"

sha1="$(cat "${v447_raw}.sha256")"
sha2="$(shasum -a 256 "$v447_raw" | awk '{print $2}')"
[[ "$sha1" == "$sha2" ]] || fail "sha256 sidecar mismatch"

recon_finalize=true
recon_sweep=false
extract_ok="$(mktemp -d)"
deno run --allow-read --allow-write --allow-run "$REPO/scripts/step82a5-safe-archive-extract.ts" \
  --archive "$v447_raw" --response-headers "$FIXTURE_HEADERS" \
  --out "$extract_ok" --slug demo >/dev/null
out_ok="$(mktemp -d)"
deno run --allow-read --allow-write --allow-run --allow-env "$REPO/scripts/step82a5-reconstruct-workdir.ts" \
  --slug demo --version 1 --ezbr dead \
  --extract-dir "$extract_ok" --out-dir "$out_ok" --archive "$v447_raw" >/dev/null 2>&1 \
  || recon_finalize=false
[[ "$recon_finalize" == "true" ]] || fail "reconstruct success branch"

extract_fail="$(mktemp -d)"
out_fail="$(mktemp -d)"
if deno run --allow-read --allow-write --allow-run --allow-env "$REPO/scripts/step82a5-reconstruct-workdir.ts" \
  --slug demo --version 1 --ezbr dead \
  --extract-dir "$extract_fail" --out-dir "$out_fail" >/dev/null 2>&1; then
  recon_sweep=true
fi
[[ "$recon_sweep" == "false" ]] || fail "reconstruct failure branch"

final_rc=0
for ready in "$recon_finalize" "$recon_sweep"; do
  [[ "$ready" == "true" ]] || final_rc=1
done
[[ "$final_rc" -ne 0 ]] || fail "aggregated rc non-zero when sweep not ready"

recon_sweep=true
final_rc=0
for ready in "$recon_finalize" "$recon_sweep"; do
  [[ "$ready" == "true" ]] || final_rc=1
done
[[ "$final_rc" -eq 0 ]] || fail "aggregated rc zero when both ready"

# ── 3. Isolated preserve-skip branches (no dependency on live audit dir) ─────
isolated_audit="$(mktemp -d)"
mkdir -p "$isolated_audit/archives"
iso_v447="$isolated_audit/archives/finalize-trip-and-capture-body.bin"
iso_sweep="$isolated_audit/archives/sweep-revolut-stale-holds-body.bin"
cp "$FIXTURE_V447" "$iso_v447"
shasum -a 256 "$iso_v447" | awk '{print $2}' > "${iso_v447}.sha256"
echo "OK" > "${iso_v447}.status"
step82a5_archive_is_preserved "$iso_v447" || fail "isolated v447 preserve-skip should pass"
pass "isolated v447 preserve-skip when sidecar OK"

step82a5_archive_is_preserved "$iso_sweep" && fail "isolated sweep must not preserve without sidecar"
cp "$FIXTURE_V447" "$iso_sweep"
shasum -a 256 "$iso_sweep" | awk '{print $2}' > "${iso_sweep}.sha256"
echo "OK" > "${iso_sweep}.status"
step82a5_archive_is_preserved "$iso_sweep" || fail "isolated sweep preserve-skip after sidecar"
pass "isolated sweep preserve-skip after mock acquisition"

pass "all downloader fixture branches"
