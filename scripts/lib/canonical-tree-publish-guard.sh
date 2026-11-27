# shellcheck shell=bash
# Canonical working-tree publish guard — source from deploy/OTA scripts.
#
# Closes the check-to-bundle race:
# 1) Exclusive mkdir lock for the whole publish window (portable; no flock binary)
# 2) Clean + origin-synced checks under the lock
# 3) Freeze deploy-relevant paths (chmod a-w) while bundling
# 4) Re-verify HEAD + clean tree before and after publish
#
# Usage (from a publish script already cd'd to repo root):
#   source "$(dirname "$0")/lib/canonical-tree-publish-guard.sh"
#   canonical_publish_begin --branch main [--expect-commit SHA] --freeze-paths "supabase/functions"
#   # ... bundle / deploy / eas update ...
#   canonical_publish_end

canonical_publish_fail() {
  echo "CANONICAL_PUBLISH_FAIL: $*" >&2
  return 1
}

canonical_publish_pass() {
  echo "CANONICAL_PUBLISH_PASS: $*"
}

CANONICAL_PUBLISH_BRANCH=""
CANONICAL_PUBLISH_SHA=""
CANONICAL_PUBLISH_FREEZE_PATHS=()
CANONICAL_PUBLISH_LOCKDIR=""
CANONICAL_PUBLISH_ACTIVE=0

_canonical_assert_clean_synced() {
  local branch="$1"
  local expect="${2:-}"

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    canonical_publish_fail "not a git repository"
    return 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "--- dirty status ---" >&2
    git status --porcelain >&2
    canonical_publish_fail "dirty working tree — commit or stash before production publish"
    return 1
  fi

  local current
  current="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$current" != "$branch" ]]; then
    canonical_publish_fail "branch is '$current', expected '$branch'"
    return 1
  fi

  git fetch origin "$branch" --quiet 2>/dev/null || true
  local local_sha remote_sha
  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "origin/$branch" 2>/dev/null || true)"
  if [[ -z "$remote_sha" ]]; then
    canonical_publish_fail "origin/$branch missing — push/sync before publish"
    return 1
  fi
  if [[ "$local_sha" != "$remote_sha" ]]; then
    canonical_publish_fail "HEAD $local_sha != origin/$branch $remote_sha — push or pull first"
    return 1
  fi

  if [[ -n "$expect" ]]; then
    local expect_full
    expect_full="$(git rev-parse --verify "${expect}^{commit}" 2>/dev/null || true)"
    if [[ "$local_sha" != "$expect" && "$local_sha" != "$expect_full" ]]; then
      canonical_publish_fail "HEAD $local_sha does not match --expect-commit $expect"
      return 1
    fi
  fi

  CANONICAL_PUBLISH_SHA="$local_sha"
  return 0
}

_canonical_freeze_paths() {
  local p
  for p in "${CANONICAL_PUBLISH_FREEZE_PATHS[@]}"; do
    [[ -e "$p" ]] || continue
    if ! chmod -R a-w "$p" 2>/dev/null; then
      canonical_publish_fail "unable to freeze path during publish: $p"
      return 1
    fi
  done
  if ((${#CANONICAL_PUBLISH_FREEZE_PATHS[@]} > 0)); then
    canonical_publish_pass "frozen paths: ${CANONICAL_PUBLISH_FREEZE_PATHS[*]}"
  fi
  return 0
}

_canonical_unfreeze_paths() {
  local p
  for p in "${CANONICAL_PUBLISH_FREEZE_PATHS[@]}"; do
    [[ -e "$p" ]] || continue
    chmod -R u+w "$p" 2>/dev/null || true
  done
}

_canonical_publish_cleanup() {
  if [[ "${CANONICAL_PUBLISH_ACTIVE}" == "1" ]]; then
    _canonical_unfreeze_paths || true
    CANONICAL_PUBLISH_ACTIVE=0
  fi
  if [[ -n "${CANONICAL_PUBLISH_LOCKDIR}" && -d "${CANONICAL_PUBLISH_LOCKDIR}" ]]; then
    rm -rf "${CANONICAL_PUBLISH_LOCKDIR}" 2>/dev/null || true
  fi
}

canonical_publish_begin() {
  local branch="main"
  local expect=""
  CANONICAL_PUBLISH_FREEZE_PATHS=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch) branch="$2"; shift 2 ;;
      --expect-commit) expect="$2"; shift 2 ;;
      --freeze-paths)
        # shellcheck disable=SC2206
        CANONICAL_PUBLISH_FREEZE_PATHS=($2)
        shift 2
        ;;
      *)
        canonical_publish_fail "unknown guard arg: $1"
        return 1
        ;;
    esac
  done

  CANONICAL_PUBLISH_BRANCH="$branch"
  if ! command -v git >/dev/null; then
    canonical_publish_fail "git not found"
    return 1
  fi

  local git_dir
  git_dir="$(git rev-parse --git-dir)"
  CANONICAL_PUBLISH_LOCKDIR="${git_dir}/onecab-canonical-publish.lockdir"
  # Atomic exclusive lock (portable on macOS — no flock binary required)
  if ! mkdir "${CANONICAL_PUBLISH_LOCKDIR}" 2>/dev/null; then
    canonical_publish_fail "another deploy/OTA holds the canonical publish lock (${CANONICAL_PUBLISH_LOCKDIR})"
    return 1
  fi
  echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${CANONICAL_PUBLISH_LOCKDIR}/holder"

  trap _canonical_publish_cleanup EXIT INT TERM
  CANONICAL_PUBLISH_ACTIVE=1

  if ! _canonical_assert_clean_synced "$branch" "$expect"; then
    return 1
  fi
  if ! _canonical_freeze_paths; then
    return 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    canonical_publish_fail "tree became dirty under lock before bundle"
    return 1
  fi
  local now
  now="$(git rev-parse HEAD)"
  if [[ "$now" != "$CANONICAL_PUBLISH_SHA" ]]; then
    canonical_publish_fail "HEAD moved under lock before bundle ($now != $CANONICAL_PUBLISH_SHA)"
    return 1
  fi

  canonical_publish_pass "locked HEAD=$CANONICAL_PUBLISH_SHA branch=$branch"
  return 0
}

canonical_publish_end() {
  local now
  now="$(git rev-parse HEAD)"
  if [[ "$now" != "$CANONICAL_PUBLISH_SHA" ]]; then
    canonical_publish_fail "HEAD changed during publish ($now != $CANONICAL_PUBLISH_SHA) — republish required"
    return 1
  fi

  _canonical_unfreeze_paths
  CANONICAL_PUBLISH_ACTIVE=0

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "--- dirty status after publish ---" >&2
    git status --porcelain >&2
    canonical_publish_fail "working tree dirty after publish — artifact may include unintended edits; investigate and republish"
    return 1
  fi

  canonical_publish_pass "integrity ok HEAD=$CANONICAL_PUBLISH_SHA"
  if [[ -n "${CANONICAL_PUBLISH_LOCKDIR}" && -d "${CANONICAL_PUBLISH_LOCKDIR}" ]]; then
    rm -rf "${CANONICAL_PUBLISH_LOCKDIR}"
  fi
  CANONICAL_PUBLISH_LOCKDIR=""
  trap - EXIT INT TERM
  return 0
}
