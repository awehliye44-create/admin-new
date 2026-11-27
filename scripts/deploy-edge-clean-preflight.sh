#!/usr/bin/env bash
# Enforceable Edge deploy preflight — reject dirty / mismatched trees and
# close the check-to-bundle race (flock + freeze supabase/functions).
#
# Permanent policy: production deploys only from the single canonical clean
# working tree at a committed, origin-synced revision.
#
# Usage:
#   scripts/deploy-edge-clean-preflight.sh \
#     --slug stop-workflow \
#     --project-ref thazislrdkjpvvghtvzo \
#     [--expect-commit SHA] \
#     [--branch main]
#
# Exit 0 only when all checks pass; then runs:
#   npx supabase functions deploy "$SLUG" --project-ref "$PROJECT_REF"
set -euo pipefail

SLUG=""
PROJECT_REF=""
EXPECT_COMMIT=""
BRANCH="main"
WORKDIR=""
SKIP_DEPLOY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --project-ref) PROJECT_REF="$2"; shift 2 ;;
    --expect-commit) EXPECT_COMMIT="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    --preflight-only) SKIP_DEPLOY=true; shift ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "DEPLOY_PREFLIGHT_FAIL: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

[[ -n "$SLUG" && -n "$PROJECT_REF" ]] || {
  echo "DEPLOY_PREFLIGHT_FAIL: --slug and --project-ref required" >&2
  exit 2
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="${WORKDIR:-$ROOT}"
cd "$WORKDIR"

# shellcheck source=lib/canonical-tree-publish-guard.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/canonical-tree-publish-guard.sh"

fail() {
  echo "DEPLOY_PREFLIGHT_FAIL: $*" >&2
  exit 1
}

pass() { echo "DEPLOY_PREFLIGHT_PASS: $*"; }

command -v npx >/dev/null || fail "npx not found"

GUARD_ARGS=(--branch "$BRANCH" --freeze-paths "supabase/functions")
if [[ -n "$EXPECT_COMMIT" ]]; then
  GUARD_ARGS+=(--expect-commit "$EXPECT_COMMIT")
fi

canonical_publish_begin "${GUARD_ARGS[@]}" || exit 1

# Function source must exist (checked under lock / freeze)
[[ -d "supabase/functions/$SLUG" || -f "supabase/functions/$SLUG/index.ts" ]] \
  || fail "function source missing: supabase/functions/$SLUG"

pass "clean tree HEAD=$CANONICAL_PUBLISH_SHA branch=$BRANCH slug=$SLUG"

if [[ "$SKIP_DEPLOY" == true ]]; then
  canonical_publish_end || exit 1
  exit 0
fi

echo "DEPLOY_PREFLIGHT: deploying $SLUG from $CANONICAL_PUBLISH_SHA …"
# Immediate pre-bundle re-check (still under flock + freeze)
[[ "$(git rev-parse HEAD)" == "$CANONICAL_PUBLISH_SHA" ]] \
  || fail "HEAD drifted immediately before deploy"
[[ -z "$(git status --porcelain)" ]] \
  || fail "tree dirty immediately before deploy"

npx supabase functions deploy "$SLUG" --project-ref "$PROJECT_REF" --workdir "$WORKDIR"
echo "DEPLOY_PREFLIGHT: deploy finished HEAD=$CANONICAL_PUBLISH_SHA"

canonical_publish_end --artifact-note "edge:$SLUG project:$PROJECT_REF" || exit 1
echo "DEPLOY_PREFLIGHT: artifact integrity verified HEAD=$CANONICAL_PUBLISH_SHA"
