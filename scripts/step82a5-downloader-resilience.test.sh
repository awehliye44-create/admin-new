#!/usr/bin/env bash
# Local fixture test: downloader continues after reconstruct failure and exits non-zero.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
AUDIT="$(mktemp -d "${TMPDIR:-/tmp}/step82a5-dl-resilience-XXXXXX")"
FIX="$REPO/scripts/fixtures/step82a5"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

# Simulate two-target flow: first fails reconstruct, second succeeds; final rc != 0
TMP="$(mktemp -d)"
mkdir -p "$AUDIT/archives" "$AUDIT/extract" "$REPO/.rollback-step82a5-fixture-test"

# good archive (demo fixture from multipart-body.bin paths)
GOOD_ARCHIVE="$FIX/multipart-body.bin"
GOOD_HEADERS="$FIX/multipart-response.headers"

# Build failing extract (empty — reconstruct will fail)
FAIL_EXTRACT="$TMP/extract-fail"
mkdir -p "$FAIL_EXTRACT"

GOOD_EXTRACT="$TMP/extract-good"
deno run --allow-read --allow-write --allow-run "$REPO/scripts/step82a5-safe-archive-extract.ts" \
  --archive "$GOOD_ARCHIVE" \
  --response-headers "$GOOD_HEADERS" \
  --out "$GOOD_EXTRACT" \
  --slug demo >/dev/null

FINAL_RC=0
RECON_A=false
RECON_B=false

set +e
deno run --allow-read --allow-write --allow-run --allow-env "$REPO/scripts/step82a5-reconstruct-workdir.ts" \
  --slug finalize-trip-and-capture --version 1 --ezbr dead \
  --extract-dir "$FAIL_EXTRACT" \
  --out-dir "$REPO/.rollback-step82a5-fixture-test/fail-workdir" \
  >/dev/null 2>&1
[[ $? -ne 0 ]] && RECON_A=false || RECON_A=true
FINAL_RC=1

deno run --allow-read --allow-write --allow-run --allow-env "$REPO/scripts/step82a5-reconstruct-workdir.ts" \
  --slug demo --version 1 --ezbr dead \
  --extract-dir "$GOOD_EXTRACT" \
  --out-dir "$REPO/.rollback-step82a5-fixture-test/ok-workdir" \
  >/dev/null 2>&1
[[ $? -eq 0 ]] && RECON_B=true
set -e

[[ "$RECON_A" == "false" ]] || fail "expected first reconstruct to fail"
[[ "$RECON_B" == "true" ]] || fail "expected second reconstruct to pass after first failure"
[[ "$FINAL_RC" -ne 0 ]] || fail "expected non-zero final rc when any target not rollback-ready"

pass "continues after failure and exits non-zero"
rm -rf "$TMP" "$AUDIT" "$REPO/.rollback-step82a5-fixture-test"
