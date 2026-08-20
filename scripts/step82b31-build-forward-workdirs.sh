#!/usr/bin/env bash
# Step 8.2B3.1 — rebuild all forward deploy workdirs with recursive closure + jail validation.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/.deploy-step82a5-forward"
AUDIT="$REPO/.audit-step82b31-2026-08-19"
mkdir -p "$AUDIT/jail" "$OUT/workdirs"

SLUGS=(
  revolut-capture-order
  admin-capture-trip-payment
  admin-refund-trip-payment
  finalize-trip-and-capture
  sweep-revolut-stale-holds
)

log() { echo "[step82b31] $*" | tee -a "$AUDIT/build.log"; }

log "=== closure build ==="
BUILD_FAIL=0
for slug in "${SLUGS[@]}"; do
  wd="$OUT/workdirs/$slug"
  rm -rf "$wd"
  log "building $slug -> $wd"
  if ! deno run --allow-read --allow-write --allow-run "$REPO/scripts/step82b31-closure-builder.ts" \
    --slug "$slug" --out-dir "$wd" >>"$AUDIT/closure-${slug}.log" 2>&1; then
    log "FAIL closure $slug"
    BUILD_FAIL=1
    continue
  fi
  log "OK closure $slug files=$(python3 -c "import json; print(json.load(open('$wd/CLOSURE_MANIFEST.json'))['local_file_count'])")"
done

if [[ "$BUILD_FAIL" -ne 0 ]]; then
  log "closure build FAILED — stopping before jail"
  exit 1
fi

log "=== jail validation ==="
JAIL_FAIL=0
for slug in "${SLUGS[@]}"; do
  wd="$OUT/workdirs/$slug"
  log "jail $slug"
  if ! deno run --allow-read --allow-write --allow-run --allow-env "$REPO/scripts/step82b31-jail-validate.ts" \
    --slug "$slug" --workdir "$wd" >"$AUDIT/jail/${slug}.json" 2>>"$AUDIT/jail/${slug}.stderr.log"; then
    log "FAIL jail $slug"
    JAIL_FAIL=1
  else
    log "OK jail $slug"
  fi
done

log "=== tree hashes ==="
deno run --allow-read --allow-run "$REPO/scripts/step82a5-hash-workdirs.ts" --root "$OUT/workdirs" \
  >"$OUT/FORWARD_TREE_HASHES.json"

log "=== external import scan ==="
deno run --allow-read "$REPO/scripts/step82b31-scan-external-imports.ts" --root "$OUT/workdirs" \
  >"$AUDIT/external-import-scan.json" 2>>"$AUDIT/build.log"

if [[ "$JAIL_FAIL" -ne 0 ]]; then
  log "jail validation FAILED"
  exit 1
fi

log "all forward workdirs built and jail-validated"
echo "FORWARD_ROOT=$OUT"
