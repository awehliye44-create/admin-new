# shellcheck shell=bash
# Canonical working-tree publish guard — source from deploy/OTA scripts.
#
# Closes the check-to-bundle race:
# 1) Exclusive mkdir lock for the whole publish window (portable; no flock binary)
# 2) Clean + origin-synced checks under the lock
# 3) Freeze deploy-relevant paths (chmod a-w) while bundling — OS-enforced
# 4) Re-verify HEAD + clean tree before and after publish
# 5) Stale-lock recovery when holder PID is dead or lock exceeds max age
# 6) Artifact traceability record under .git/onecab-publish-log/
#
# Usage (from a publish script already cd'd to repo root):
#   source "$(dirname "$0")/lib/canonical-tree-publish-guard.sh"
#   canonical_publish_begin --branch main [--expect-commit SHA] --freeze-paths "supabase/functions"
#   # ... bundle / deploy / eas update ...
#   canonical_publish_end [--artifact-note "stop-workflow v725"]

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
CANONICAL_PUBLISH_STARTED_AT=""
# Stale lock: holder PID dead, or lock older than this many seconds (default 2h)
CANONICAL_PUBLISH_STALE_LOCK_SECONDS="${CANONICAL_PUBLISH_STALE_LOCK_SECONDS:-7200}"

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

# Prove freeze is OS-enforced (not cooperative-only).
# Writes must fail under freeze; used by tests and optional --verify-freeze.
canonical_publish_assert_freeze_blocks_writes() {
  local probe=""
  local p
  for p in "${CANONICAL_PUBLISH_FREEZE_PATHS[@]}"; do
    if [[ -d "$p" ]]; then
      probe="$p/.onecab_freeze_probe_$$"
      break
    elif [[ -f "$p" ]]; then
      # Cannot create sibling safely; skip file-only freeze for probe
      continue
    fi
  done
  if [[ -z "$probe" ]]; then
    canonical_publish_pass "freeze write-probe skipped (no directory freeze path)"
    return 0
  fi
  if ( : >"$probe" ) 2>/dev/null; then
    rm -f "$probe" 2>/dev/null || true
    canonical_publish_fail "freeze did not block write to $probe — aborting publish"
    return 1
  fi
  canonical_publish_pass "freeze blocks writes (OS-enforced)"
  return 0
}

_canonical_lock_is_stale() {
  local lockdir="$1"
  local holder="$lockdir/holder"
  [[ -d "$lockdir" ]] || return 1
  local pid="" age_ok=0
  if [[ -f "$holder" ]]; then
    pid="$(awk '{print $1}' "$holder" 2>/dev/null || true)"
    local started
    started="$(awk '{print $2}' "$holder" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      # Holder alive — check age only as secondary
      if [[ -n "$started" ]]; then
        local now epoch_started
        now="$(date -u +%s)"
        epoch_started="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$started" +%s 2>/dev/null \
          || date -u -d "$started" +%s 2>/dev/null || echo 0)"
        if [[ "$epoch_started" != "0" ]] && (( now - epoch_started > CANONICAL_PUBLISH_STALE_LOCK_SECONDS )); then
          echo "CANONICAL_PUBLISH_WARN: lock held by live pid $pid beyond ${CANONICAL_PUBLISH_STALE_LOCK_SECONDS}s" >&2
        fi
      fi
      return 1 # not stale — live holder
    fi
    # PID missing or dead → stale
    return 0
  fi
  # No holder file — treat as stale
  return 0
}

_canonical_try_recover_stale_lock() {
  local lockdir="$1"
  if _canonical_lock_is_stale "$lockdir"; then
    echo "CANONICAL_PUBLISH_WARN: recovering stale publish lock at $lockdir" >&2
    # Best-effort unfreeze from prior crash (paths may still be a-w)
    return 0
  fi
  return 1
}

_canonical_write_trace() {
  local status="$1"
  local note="${2:-}"
  local git_dir
  git_dir="$(git rev-parse --git-dir)"
  local logdir="${git_dir}/onecab-publish-log"
  mkdir -p "$logdir"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local file="${logdir}/${ts}-${status}-${CANONICAL_PUBLISH_SHA:0:12}.json"
  cat >"$file" <<EOF
{
  "status": "$(printf '%s' "$status" | sed 's/"/\\"/g')",
  "head": "$CANONICAL_PUBLISH_SHA",
  "branch": "$CANONICAL_PUBLISH_BRANCH",
  "started_at": "$CANONICAL_PUBLISH_STARTED_AT",
  "finished_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pid": $$,
  "cwd": "$(pwd)",
  "freeze_paths": "$(printf '%s' "${CANONICAL_PUBLISH_FREEZE_PATHS[*]}" | sed 's/"/\\"/g')",
  "note": "$(printf '%s' "$note" | sed 's/"/\\"/g')"
}
EOF
  # Symlink latest for quick read
  ln -sfn "$(basename "$file")" "${logdir}/latest.json" 2>/dev/null || true
  echo "CANONICAL_PUBLISH_TRACE: $file"
}

_canonical_publish_cleanup() {
  local exit_hint="${1:-interrupted}"
  if [[ "${CANONICAL_PUBLISH_ACTIVE}" == "1" ]]; then
    _canonical_unfreeze_paths || true
    CANONICAL_PUBLISH_ACTIVE=0
    if [[ -n "${CANONICAL_PUBLISH_SHA}" ]]; then
      _canonical_write_trace "$exit_hint" "trap cleanup" 2>/dev/null || true
    fi
  fi
  if [[ -n "${CANONICAL_PUBLISH_LOCKDIR}" && -d "${CANONICAL_PUBLISH_LOCKDIR}" ]]; then
    rm -rf "${CANONICAL_PUBLISH_LOCKDIR}" 2>/dev/null || true
  fi
}

canonical_publish_begin() {
  local branch="main"
  local expect=""
  local verify_freeze=1
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
      --skip-freeze-probe) verify_freeze=0; shift ;;
      *)
        canonical_publish_fail "unknown guard arg: $1"
        return 1
        ;;
    esac
  done

  CANONICAL_PUBLISH_BRANCH="$branch"
  CANONICAL_PUBLISH_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! command -v git >/dev/null; then
    canonical_publish_fail "git not found"
    return 1
  fi

  local git_dir
  git_dir="$(git rev-parse --git-dir)"
  CANONICAL_PUBLISH_LOCKDIR="${git_dir}/onecab-canonical-publish.lockdir"

  if [[ -d "${CANONICAL_PUBLISH_LOCKDIR}" ]]; then
    if _canonical_try_recover_stale_lock "${CANONICAL_PUBLISH_LOCKDIR}"; then
      # Attempt to clear read-only freeze leftovers from crashed publish
      chmod -R u+w supabase/functions src app public 2>/dev/null || true
      rm -rf "${CANONICAL_PUBLISH_LOCKDIR}"
    else
      canonical_publish_fail "another deploy/OTA holds the canonical publish lock (${CANONICAL_PUBLISH_LOCKDIR})"
      return 1
    fi
  fi

  if ! mkdir "${CANONICAL_PUBLISH_LOCKDIR}" 2>/dev/null; then
    canonical_publish_fail "another deploy/OTA holds the canonical publish lock (${CANONICAL_PUBLISH_LOCKDIR})"
    return 1
  fi
  echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${CANONICAL_PUBLISH_LOCKDIR}/holder"

  trap '_canonical_publish_cleanup interrupted' EXIT INT TERM
  CANONICAL_PUBLISH_ACTIVE=1

  if ! _canonical_assert_clean_synced "$branch" "$expect"; then
    return 1
  fi
  if ! _canonical_freeze_paths; then
    return 1
  fi
  if [[ "$verify_freeze" == "1" ]]; then
    if ! canonical_publish_assert_freeze_blocks_writes; then
      return 1
    fi
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
  local note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --artifact-note) note="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local now
  now="$(git rev-parse HEAD)"
  if [[ "$now" != "$CANONICAL_PUBLISH_SHA" ]]; then
    _canonical_write_trace "failed_head_drift" "$note"
    canonical_publish_fail "HEAD changed during publish ($now != $CANONICAL_PUBLISH_SHA) — republish required"
    return 1
  fi

  _canonical_unfreeze_paths
  CANONICAL_PUBLISH_ACTIVE=0

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "--- dirty status after publish ---" >&2
    git status --porcelain >&2
    _canonical_write_trace "failed_dirty_after" "$note"
    canonical_publish_fail "working tree dirty after publish — artifact may include unintended edits; investigate and republish"
    return 1
  fi

  _canonical_write_trace "ok" "$note"
  canonical_publish_pass "integrity ok HEAD=$CANONICAL_PUBLISH_SHA"
  if [[ -n "${CANONICAL_PUBLISH_LOCKDIR}" && -d "${CANONICAL_PUBLISH_LOCKDIR}" ]]; then
    rm -rf "${CANONICAL_PUBLISH_LOCKDIR}"
  fi
  CANONICAL_PUBLISH_LOCKDIR=""
  trap - EXIT INT TERM
  return 0
}
