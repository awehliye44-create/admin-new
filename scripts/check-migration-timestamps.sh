#!/usr/bin/env bash
# Fail if two migration files share the same 14-digit version timestamp.
# Duplicate timestamps break `supabase db push` (CLI keys history by version only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/supabase/migrations"
dups="$(
  find "$DIR" -maxdepth 1 -name '*.sql' -print0 \
    | xargs -0 -n1 basename \
    | sed -n 's/^\([0-9]\{14\}\).*/\1/p' \
    | sort \
    | uniq -d
)"
if [[ -n "$dups" ]]; then
  echo "ERROR: duplicate supabase migration timestamps:" >&2
  echo "$dups" >&2
  echo "Rename colliding files so each version is unique, then repair history if needed." >&2
  exit 1
fi
echo "OK: no duplicate migration timestamps in $DIR"
