#!/usr/bin/env bash
# Step 8.2A.5 — validate rollback workdir (local only, no deploy).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
slug="${1:?usage: step82a5-validate-workdir.sh SLUG WORKDIR}"
workdir="${2:?usage: step82a5-validate-workdir.sh SLUG WORKDIR}"
AUDIT="${3:-$REPO/.audit-step82a5-2026-08-19}"
mkdir -p "$AUDIT/validate"

log() { echo "[step82a5-validate] $slug: $*" | tee -a "$AUDIT/validate/${slug}.log"; }
entry="$workdir/supabase/functions/$slug/index.ts"

log "deno check"
set +e
( cd "$workdir" && deno check "$entry" ) >>"$AUDIT/validate/${slug}.log" 2>&1
deno_rc=$?
set -e
log "deno check rc=$deno_rc"

log "local bundle (no upload)"
set +e
( cd "$workdir" && deno bundle "$entry" >"$AUDIT/validate/${slug}.bundle.js" ) >>"$AUDIT/validate/${slug}.log" 2>&1
bundle_rc=$?
set -e
log "bundle rc=$bundle_rc"

log "workdir layout"
test -f "$workdir/supabase/config.toml"
test -f "$entry"
test -d "$workdir/supabase/functions"

log "import graph + external violations"
deno run --allow-read "$REPO/scripts/step82a5-hash-workdirs.ts" --root "$(dirname "$workdir")" \
  >"$AUDIT/validate/${slug}-tree.json" 2>>"$AUDIT/validate/${slug}.log" || true

log "regression lock tests (repo)"
cd "$REPO"
set +e
deno test --allow-read supabase/functions/_shared/providerRefundAtomicRpcLock.test.ts \
  >>"$AUDIT/validate/${slug}.log" 2>&1
lock_rc=$?
set -e
log "lock tests rc=$lock_rc"

{
  echo "slug=$slug"
  echo "workdir=$workdir"
  echo "deno_check_rc=$deno_rc"
  echo "bundle_rc=$bundle_rc"
  echo "lock_tests_rc=$lock_rc"
} > "$AUDIT/validate/${slug}.summary"

if [[ $deno_rc -ne 0 || $bundle_rc -ne 0 ]]; then
  exit 1
fi
