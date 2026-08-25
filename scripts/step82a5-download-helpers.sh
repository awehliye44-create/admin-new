#!/usr/bin/env bash
# Shared helpers for Step 8.2A.5 downloader (bash 3.2+ compatible).

# Returns 0 when a previously acquired raw archive should be reused.
step82a5_archive_is_preserved() {
  local raw_out="$1"
  local status=""
  status="$(cat "${raw_out}.status" 2>/dev/null || true)"
  [[ -f "$raw_out" && -f "${raw_out}.sha256" && "$status" == "OK" ]]
}

# Returns 0 when HTTP status is outside the 2xx success range.
step82a5_http_response_is_error() {
  local http_code="$1"
  [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]
}

# TSV slug status store (slug<TAB>value) — safe for hyphenated slugs on bash 3.2.
step82a5_status_set() {
  local file="$1"
  local slug="$2"
  local value="$3"
  local tmp="${file}.tmp.$$"
  local found=false
  : > "$tmp"
  if [[ -f "$file" ]]; then
    while IFS=$'\t' read -r line_slug line_val || [[ -n "${line_slug:-}" ]]; do
      [[ -z "${line_slug:-}" ]] && continue
      if [[ "$line_slug" == "$slug" ]]; then
        printf '%s\t%s\n' "$slug" "$value" >> "$tmp"
        found=true
      else
        printf '%s\t%s\n' "$line_slug" "$line_val" >> "$tmp"
      fi
    done < "$file"
  fi
  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\n' "$slug" "$value" >> "$tmp"
  fi
  mv "$tmp" "$file"
}

step82a5_status_get() {
  local file="$1"
  local slug="$2"
  local fallback="${3:-false}"
  if [[ ! -f "$file" ]]; then
    printf '%s' "$fallback"
    return 0
  fi
  while IFS=$'\t' read -r line_slug line_val || [[ -n "${line_slug:-}" ]]; do
    [[ -z "${line_slug:-}" ]] && continue
    if [[ "$line_slug" == "$slug" ]]; then
      printf '%s' "$line_val"
      return 0
    fi
  done < "$file"
  printf '%s' "$fallback"
}

step82a5_write_download_summary() {
  local audit_dir="$1"
  local ftc_archive="$2"
  local ftc_recon="$3"
  local sweep_archive="$4"
  local sweep_recon="$5"
  python3 - <<PY > "$audit_dir/download-summary.json"
import json
def b(s):
    return s == "true"
print(json.dumps({
  "finalize-trip-and-capture": {
    "archive": b("$ftc_archive"),
    "rollback_ready": b("$ftc_recon"),
  },
  "sweep-revolut-stale-holds": {
    "archive": b("$sweep_archive"),
    "rollback_ready": b("$sweep_recon"),
  },
}, indent=2))
PY
}
