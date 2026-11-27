#!/usr/bin/env bash
# Enforceable Edge deploy preflight — reject dirty / mismatched trees.
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

fail() {
  echo "DEPLOY_PREFLIGHT_FAIL: $*" >&2
  exit 1
}

pass() { echo "DEPLOY_PREFLIGHT_PASS: $*"; }

command -v git >/dev/null || fail "git not found"
command -v npx >/dev/null || fail "npx not found"

# 1) Inside a git work tree
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a git repository"

# 2) Clean working tree (no staged/unstaged/untracked in deploy-relevant paths)
# Full tree must be clean — no parallel WIP that could enter the bundle.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "--- dirty status ---" >&2
  git status --porcelain >&2
  fail "dirty working tree — commit or stash before production deploy"
fi

# 3) On expected branch (default main)
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$CURRENT_BRANCH" == "$BRANCH" ]] || fail "branch is '$CURRENT_BRANCH', expected '$BRANCH'"

# 4) HEAD must equal origin/<branch> (synchronised)
git fetch origin "$BRANCH" --quiet 2>/dev/null || true
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)"
[[ -n "$REMOTE_SHA" ]] || fail "origin/$BRANCH missing — push/sync before deploy"
[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] || fail "HEAD $LOCAL_SHA != origin/$BRANCH $REMOTE_SHA — push or pull first"

# 5) Optional exact commit pin
if [[ -n "$EXPECT_COMMIT" ]]; then
  [[ "$LOCAL_SHA" == "$EXPECT_COMMIT" || "$LOCAL_SHA" == "$(git rev-parse --verify "$EXPECT_COMMIT^{commit}")" ]] \
    || fail "HEAD $LOCAL_SHA does not match --expect-commit $EXPECT_COMMIT"
fi

# 6) Function source must exist
[[ -d "supabase/functions/$SLUG" || -f "supabase/functions/$SLUG/index.ts" ]] \
  || fail "function source missing: supabase/functions/$SLUG"

pass "clean tree HEAD=$LOCAL_SHA branch=$BRANCH slug=$SLUG"

if [[ "$SKIP_DEPLOY" == true ]]; then
  exit 0
fi

echo "DEPLOY_PREFLIGHT: deploying $SLUG from $LOCAL_SHA …"
npx supabase functions deploy "$SLUG" --project-ref "$PROJECT_REF" --workdir "$WORKDIR"
echo "DEPLOY_PREFLIGHT: deploy finished HEAD=$LOCAL_SHA"
